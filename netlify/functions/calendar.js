// Netlify serverless function: reads the Family Google Calendar's secret iCal feed
// (GOOGLE_CAL_URL) and returns events from today through 7 days ahead.
// v2 (Oct 2026): correct time zones (incl. DST), recurring-event edits and deletions
// (RECURRENCE-ID / EXDATE), weekly/monthly "by day" rules, multi-day all-day events,
// and duplicate removal. Each event includes `date` = its local day (YYYY-MM-DD).
const HOME_TZ = 'America/Chicago';
const WINDOW_DAYS = 7;
 
exports.handler = async function(event, context) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
 
  const calUrl = process.env.GOOGLE_CAL_URL;
  if (!calUrl) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Calendar URL not configured' }) };
 
  try {
    const response = await fetch(calUrl);
    if (!response.ok) throw new Error('Failed to fetch calendar');
    const ics = await response.text();
    const events = buildEvents(ics, new Date());
    return { statusCode: 200, headers, body: JSON.stringify({ events }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
 
// ───────── time zone helpers ─────────
const fmtCache = {};
function partsIn(ms, tz) {
  let f = fmtCache[tz];
  if (!f) {
    f = fmtCache[tz] = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  }
  const p = {};
  f.formatToParts(new Date(ms)).forEach(x => { if (x.type !== 'literal') p[x.type] = +x.value; });
  return { y: p.year, m: p.month, d: p.day, h: p.hour % 24, mi: p.minute, s: p.second };
}
function validTz(tz) {
  if (!tz) return HOME_TZ;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch (e) { return HOME_TZ; }
}
// Wall-clock time in a zone → UTC milliseconds
function zonedToUtc(y, m, d, h, mi, s, tz) {
  const target = Date.UTC(y, m - 1, d, h, mi, s);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const p = partsIn(guess, tz);
    const shown = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
    const next = guess + (target - shown);
    if (next === guess) break;
    guess = next;
  }
  return guess;
}
const pad = n => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
function localDate(ms, tz) { const p = partsIn(ms, tz || HOME_TZ); return ymd(p.y, p.m, p.d); }
function addDaysYmd(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
 
// ───────── iCal parsing ─────────
function unfold(data) { return data.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').replace(/\r/g, '').split('\n'); }
function parseLine(line) {
  const c = line.indexOf(':');
  if (c === -1) return null;
  const left = line.slice(0, c), value = line.slice(c + 1);
  const bits = left.split(';');
  const params = {};
  bits.slice(1).forEach(b => { const e = b.indexOf('='); if (e > 0) params[b.slice(0, e).toUpperCase()] = b.slice(e + 1).replace(/^"|"$/g, ''); });
  return { key: bits[0].toUpperCase(), params, value };
}
function unescapeIcal(s) { return s.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\'); }
 
// Returns { allDay, date } or { allDay:false, ms, tz, wall:{y,m,d,h,mi,s} }
function parseDateValue(value, params) {
  const v = value.trim();
  if ((params && params.VALUE === 'DATE') || /^\d{8}$/.test(v)) {
    return { allDay: true, date: ymd(+v.slice(0, 4), +v.slice(4, 6), +v.slice(6, 8)) };
  }
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return null;
  const wall = { y: +m[1], m: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +m[6] };
  if (m[7] === 'Z') {
    const ms = Date.UTC(wall.y, wall.m - 1, wall.d, wall.h, wall.mi, wall.s);
    return { allDay: false, ms, tz: 'UTC', wall };
  }
  const tz = validTz(params && params.TZID);
  return { allDay: false, ms: zonedToUtc(wall.y, wall.m, wall.d, wall.h, wall.mi, wall.s, tz), tz, wall };
}
function parseDuration(v) {
  const m = (v || '').match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return 0;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * ((+m[2] || 0) * 604800 + (+m[3] || 0) * 86400 + (+m[4] || 0) * 3600 + (+m[5] || 0) * 60 + (+m[6] || 0)) * 1000;
}
function occKey(dv) { return dv.allDay ? 'D' + dv.date : 'T' + dv.ms; }
 
function parseIcs(ics) {
  const vevents = [];
  let cur = null;
  unfold(ics).forEach(line => {
    if (line === 'BEGIN:VEVENT') { cur = { exdates: [] }; return; }
    if (line === 'END:VEVENT') { if (cur) vevents.push(cur); cur = null; return; }
    if (!cur) return;
    const p = parseLine(line);
    if (!p) return;
    switch (p.key) {
      case 'UID': cur.uid = p.value.trim(); break;
      case 'SUMMARY': cur.title = unescapeIcal(p.value); break;
      case 'LOCATION': cur.location = unescapeIcal(p.value); break;
      case 'DESCRIPTION': cur.description = unescapeIcal(p.value).slice(0, 300); break;
      case 'STATUS': cur.status = p.value.trim().toUpperCase(); break;
      case 'DTSTART': cur.start = parseDateValue(p.value, p.params); break;
      case 'DTEND': cur.end = parseDateValue(p.value, p.params); break;
      case 'DURATION': cur.duration = parseDuration(p.value.trim()); break;
      case 'RRULE': cur.rrule = p.value.trim(); break;
      case 'RECURRENCE-ID': cur.recurrenceId = parseDateValue(p.value, p.params); break;
      case 'EXDATE':
        p.value.split(',').forEach(v => { const dv = parseDateValue(v, p.params); if (dv) cur.exdates.push(dv); });
        break;
    }
  });
  return vevents;
}
 
// ───────── recurrence expansion ─────────
const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
function parseRRule(s) {
  const r = {};
  s.split(';').forEach(part => { const e = part.indexOf('='); if (e > 0) r[part.slice(0, e).toUpperCase()] = part.slice(e + 1); });
  return {
    freq: r.FREQ || 'DAILY',
    interval: Math.max(1, parseInt(r.INTERVAL, 10) || 1),
    count: r.COUNT ? parseInt(r.COUNT, 10) : null,
    until: r.UNTIL ? parseDateValue(r.UNTIL, {}) : null,
    byday: r.BYDAY ? r.BYDAY.split(',').map(x => { const m = x.match(/^([+-]?\d+)?([A-Z]{2})$/); return m ? { n: m[1] ? parseInt(m[1], 10) : null, wd: DAY_CODES.indexOf(m[2]) } : null; }).filter(Boolean) : null,
    bymonthday: r.BYMONTHDAY ? r.BYMONTHDAY.split(',').map(Number) : null,
    bymonth: r.BYMONTH ? r.BYMONTH.split(',').map(Number) : null,
  };
}
const dayOfWeek = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
 
// Yields candidate local dates [y,m,d] in order, period by period.
function candidateDates(rule, y0, m0, d0, maxPeriods) {
  const out = [];
  for (let k = 0; k < maxPeriods; k++) {
    let dates = [];
    if (rule.freq === 'DAILY') {
      const t = new Date(Date.UTC(y0, m0 - 1, d0 + k * rule.interval));
      dates = [[t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()]];
    } else if (rule.freq === 'WEEKLY') {
      // weeks start Monday (iCal default WKST=MO)
      const startDow = (dayOfWeek(y0, m0, d0) + 6) % 7;
      const weekStart = new Date(Date.UTC(y0, m0 - 1, d0 - startDow + 7 * k * rule.interval));
      const wds = rule.byday ? rule.byday.map(b => b.wd) : [dayOfWeek(y0, m0, d0)];
      dates = wds.map(wd => {
        const t = new Date(weekStart); t.setUTCDate(t.getUTCDate() + ((wd + 6) % 7));
        return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
      });
    } else if (rule.freq === 'MONTHLY') {
      const base = new Date(Date.UTC(y0, m0 - 1 + k * rule.interval, 1));
      const y = base.getUTCFullYear(), m = base.getUTCMonth() + 1, dim = daysInMonth(y, m);
      if (rule.byday) {
        rule.byday.forEach(b => {
          const all = [];
          for (let d = 1; d <= dim; d++) if (dayOfWeek(y, m, d) === b.wd) all.push(d);
          if (b.n === null) all.forEach(d => dates.push([y, m, d]));
          else { const d = b.n > 0 ? all[b.n - 1] : all[all.length + b.n]; if (d) dates.push([y, m, d]); }
        });
      } else {
        (rule.bymonthday || [d0]).forEach(md => { const d = md > 0 ? md : dim + md + 1; if (d >= 1 && d <= dim) dates.push([y, m, d]); });
      }
    } else if (rule.freq === 'YEARLY') {
      const y = y0 + k * rule.interval;
      (rule.bymonth || [m0]).forEach(m => { if (d0 <= daysInMonth(y, m)) dates.push([y, m, d0]); });
    }
    dates.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]));
    out.push(dates);
  }
  return out;
}
 
function expand(ev, windowStart, windowEnd) {
  const rule = parseRRule(ev.rrule);
  const s = ev.start;
  const startDate = s.allDay ? s.date : ymd(s.wall.y, s.wall.m, s.wall.d);
  const [y0, m0, d0] = startDate.split('-').map(Number);
  const tz = s.allDay ? HOME_TZ : s.tz;
  const untilMs = rule.until ? (rule.until.allDay ? zonedToUtc(...rule.until.date.split('-').map(Number), 23, 59, 59, tz) : rule.until.ms) : Infinity;
  const startKeyMs = s.allDay ? null : s.ms;
  const out = [];
  let produced = 0;
  const periods = rule.freq === 'DAILY' ? 4000 : rule.freq === 'WEEKLY' ? 1200 : 400;
  const groups = candidateDates(rule, y0, m0, d0, periods);
  for (const group of groups) {
    for (const [y, m, d] of group) {
      const date = ymd(y, m, d);
      if (date < startDate) continue;
      let occ;
      if (s.allDay) {
        occ = { allDay: true, date };
        if (zonedToUtc(y, m, d, 0, 0, 0, tz) > untilMs) return out;
      } else {
        const ms = s.tz === 'UTC'
          ? Date.UTC(y, m - 1, d, s.wall.h, s.wall.mi, s.wall.s)
          : zonedToUtc(y, m, d, s.wall.h, s.wall.mi, s.wall.s, tz);
        if (ms < startKeyMs) continue;
        if (ms > untilMs) return out;
        occ = { allDay: false, ms, tz };
      }
      produced++;
      if (rule.count && produced > rule.count) return out;
      const occDate = occ.allDay ? occ.date : localDate(occ.ms);
      if (occDate > windowEnd) return out;
      out.push(occ);
    }
  }
  return out;
}
 
// ───────── build the event list ─────────
function buildEvents(ics, now) {
  const today = localDate(now.getTime());
  const windowEnd = addDaysYmd(today, WINDOW_DAYS);
  const vevents = parseIcs(ics).filter(v => v.start && v.title);
 
  // Edited single instances of recurring events, keyed by series UID
  const overrides = {};
  vevents.filter(v => v.recurrenceId).forEach(v => { (overrides[v.uid] = overrides[v.uid] || []).push(v); });
 
  const results = [];
  function emit(v, occ) {
    if (v.status === 'CANCELLED') return;
    if (occ.allDay) {
      // all-day: one entry per day it covers inside the window
      let endDate = addDaysYmd(occ.date, 1);
      if (v.end && v.end.allDay && v.start.allDay) {
        const span = Math.round((Date.parse(v.end.date) - Date.parse(v.start.date)) / 86400000);
        if (span > 1) endDate = addDaysYmd(occ.date, span);
      }
      for (let d = occ.date; d < endDate; d = addDaysYmd(d, 1)) {
        if (d >= today && d <= windowEnd) {
          results.push({ title: v.title, date: d, start: d, end: endDate, allDay: true, location: v.location || null, description: v.description || null });
        }
      }
      return;
    }
    let durMs = 0;
    if (v.end && !v.end.allDay) durMs = v.end.ms - v.start.ms;
    else if (v.duration) durMs = v.duration;
    const date = localDate(occ.ms);
    if (date < today || date > windowEnd) return;
    results.push({
      title: v.title, date,
      start: new Date(occ.ms).toISOString(),
      end: durMs > 0 ? new Date(occ.ms + durMs).toISOString() : null,
      allDay: false, location: v.location || null, description: v.description || null,
    });
  }
 
  vevents.forEach(v => {
    if (v.recurrenceId) { emit(v, v.start); return; } // edited instance: shown as-is
    if (!v.rrule) { emit(v, v.start); return; }
    const skip = {};
    v.exdates.forEach(x => { skip[occKey(x)] = true; });
    (overrides[v.uid] || []).forEach(o => { skip[occKey(o.recurrenceId)] = true; });
    expand(v, today, windowEnd).forEach(occ => {
      if (skip[occKey(occ)]) return;
      if (!occ.allDay && skip['D' + localDate(occ.ms)]) return; // EXDATE given as a date
      emit(v, occ);
    });
  });
 
  // Remove exact duplicates (same title and same start)
  const seen = {};
  const unique = results.filter(e => {
    const k = e.title.trim().toLowerCase() + '|' + e.start + '|' + e.date;
    if (seen[k]) return false;
    seen[k] = true; return true;
  });
 
  unique.sort((a, b) => (a.date.localeCompare(b.date)) || ((a.allDay ? 0 : 1) - (b.allDay ? 0 : 1)) || a.start.localeCompare(b.start));
  return unique;
}
 
exports.buildEvents = buildEvents;
 
