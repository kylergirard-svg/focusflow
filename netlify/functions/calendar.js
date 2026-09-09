// Netlify serverless function to fetch and parse Google Calendar iCal feed
exports.handler = async function(event, context) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const calUrl = process.env.GOOGLE_CAL_URL;
  if (!calUrl) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Calendar URL not configured' }) };
  }

  try {
    const response = await fetch(calUrl);
    if (!response.ok) throw new Error('Failed to fetch calendar');
    const icalData = await response.text();
    const events = parseICal(icalData);
    return { statusCode: 200, headers, body: JSON.stringify({ events }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};

function parseICal(data) {
  const events = [];
  const lines = unfoldLines(data);
  let currentEvent = null;

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      currentEvent = {};
    } else if (line === 'END:VEVENT' && currentEvent) {
      if (currentEvent.summary && currentEvent.status !== 'CANCELLED') {
        events.push({
          title: currentEvent.summary,
          start: currentEvent.dtstart,
          end: currentEvent.dtend,
          location: currentEvent.location || null,
          description: currentEvent.description || null,
          allDay: currentEvent.allDay || false,
          recurrence: currentEvent.rrule || null,
        });
      }
      currentEvent = null;
    } else if (currentEvent) {
      const { key, params, value } = parseLine(line);
      switch (key) {
        case 'SUMMARY':
          currentEvent.summary = unescapeIcal(value);
          break;
        case 'DTSTART':
          currentEvent.dtstart = parseICalDate(value, params);
          currentEvent.allDay = isDateOnly(value, params);
          break;
        case 'DTEND':
          currentEvent.dtend = parseICalDate(value, params);
          break;
        case 'LOCATION':
          currentEvent.location = unescapeIcal(value);
          break;
        case 'DESCRIPTION':
          currentEvent.description = unescapeIcal(value).slice(0, 200);
          break;
        case 'STATUS':
          currentEvent.status = value;
          break;
        case 'RRULE':
          currentEvent.rrule = value;
          break;
      }
    }
  }

  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const weekAhead = new Date(now);
  weekAhead.setDate(weekAhead.getDate() + 7);
  const weekAheadStr = weekAhead.toISOString().slice(0, 10);

  const expanded = [];
  for (const evt of events) {
    if (evt.recurrence) {
      const instances = expandRecurrence(evt, todayStr, weekAheadStr);
      expanded.push(...instances);
    } else {
      expanded.push(evt);
    }
  }

  const filtered = expanded.filter(evt => {
    if (!evt.start) return false;
    const evtDate = evt.start.slice(0, 10);
    return evtDate >= todayStr && evtDate <= weekAheadStr;
  });

  filtered.sort((a, b) => (a.start || '').localeCompare(b.start || ''));
  return filtered;
}

function unfoldLines(data) {
  return data.replace(/\r\n /g, '').replace(/\r\n\t/g, '').replace(/\r/g, '').split('\n');
}

function parseLine(line) {
  const colonIdx = line.indexOf(':');
  if (colonIdx === -1) return { key: '', params: '', value: '' };
  const left = line.slice(0, colonIdx);
  const value = line.slice(colonIdx + 1);
  const semiIdx = left.indexOf(';');
  if (semiIdx === -1) return { key: left.toUpperCase(), params: '', value };
  return { key: left.slice(0, semiIdx).toUpperCase(), params: left.slice(semiIdx + 1), value };
}

function parseICalDate(value, params) {
  if (/^\d{8}$/.test(value)) {
    return `${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}`;
  }
  if (/^\d{8}T\d{6}/.test(value)) {
    const y = value.slice(0,4), m = value.slice(4,6), d = value.slice(6,8);
    const hh = value.slice(9,11), mm = value.slice(11,13), ss = value.slice(13,15);
    const isUTC = value.endsWith('Z');
    if (isUTC) {
      const dt = new Date(Date.UTC(+y, +m-1, +d, +hh, +mm, +ss));
      return dt.toISOString();
    }
    return `${y}-${m}-${d}T${hh}:${mm}:${ss}`;
  }
  return value;
}

function isDateOnly(value, params) {
  if (params && params.toUpperCase().includes('VALUE=DATE')) return true;
  return /^\d{8}$/.test(value);
}

function unescapeIcal(str) {
  return str.replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

function expandRecurrence(evt, startRange, endRange) {
  const instances = [];
  const rule = parseRRule(evt.recurrence);
  if (!rule || !evt.start) return [evt];

  const baseDate = new Date(evt.start.slice(0, 10) + 'T12:00:00Z');
  const rangeStart = new Date(startRange + 'T00:00:00Z');
  const rangeEnd = new Date(endRange + 'T23:59:59Z');
  const until = rule.until ? new Date(rule.until + 'T23:59:59Z') : new Date(rangeEnd);
  const count = rule.count || 1000;
  const interval = rule.interval || 1;
  const baseTime = evt.start.length > 10 ? evt.start.slice(10) : '';
  const duration = getDurationMs(evt.start, evt.end);

  let current = new Date(baseDate);
  let generated = 0;

  for (let i = 0; i < 2000 && current <= until && current <= rangeEnd && generated < count; i++) {
    if (current >= rangeStart && current <= rangeEnd) {
      const dateStr = current.toISOString().slice(0, 10);
      const newStart = baseTime ? dateStr + baseTime : dateStr;
      const newEnd = duration && evt.end ? computeEnd(newStart, duration) : evt.end;
      instances.push({
        ...evt,
        start: newStart,
        end: newEnd,
        recurrence: null,
      });
    }
    generated++;
    current = advanceDate(current, rule.freq, interval);
    if (current > rangeEnd) break;
  }

  return instances;
}

function parseRRule(rrule) {
  if (!rrule) return null;
  const parts = {};
  rrule.split(';').forEach(part => {
    const [k, v] = part.split('=');
    if (k && v) parts[k.toUpperCase()] = v;
  });
  return {
    freq: parts.FREQ || 'YEARLY',
    interval: parseInt(parts.INTERVAL) || 1,
    until: parts.UNTIL ? parseICalDate(parts.UNTIL, '') : null,
    count: parts.COUNT ? parseInt(parts.COUNT) : null,
    byday: parts.BYDAY || null,
