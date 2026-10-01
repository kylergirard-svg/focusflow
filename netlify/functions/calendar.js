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
    return { statusCode: 200, headers, body: JSON.stringify({ events: events }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};

function parseICal(data) {
  var events = [];
  var lines = unfoldLines(data);
  var currentEvent = null;

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
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
      var parsed = parseLine(line);
      var key = parsed.key;
      var params = parsed.params;
      var value = parsed.value;
      if (key === 'SUMMARY') {
        currentEvent.summary = unescapeIcal(value);
      } else if (key === 'DTSTART') {
        currentEvent.dtstart = parseICalDate(value, params);
        currentEvent.allDay = isDateOnly(value, params);
      } else if (key === 'DTEND') {
        currentEvent.dtend = parseICalDate(value, params);
      } else if (key === 'LOCATION') {
        currentEvent.location = unescapeIcal(value);
      } else if (key === 'DESCRIPTION') {
        currentEvent.description = unescapeIcal(value).slice(0, 200);
      } else if (key === 'STATUS') {
        currentEvent.status = value;
      } else if (key === 'RRULE') {
        currentEvent.rrule = value;
      }
    }
  }

  var now = new Date();
  var todayStr = now.toISOString().slice(0, 10);
  var weekAhead = new Date(now);
  weekAhead.setDate(weekAhead.getDate() + 7);
  var weekAheadStr = weekAhead.toISOString().slice(0, 10);

  var expanded = [];
  for (var j = 0; j < events.length; j++) {
    var evt = events[j];
    if (evt.recurrence) {
      var instances = expandRecurrence(evt, todayStr, weekAheadStr);
      for (var k = 0; k < instances.length; k++) {
        expanded.push(instances[k]);
      }
    } else {
      expanded.push(evt);
    }
  }

  var filtered = expanded.filter(function(evt) {
    if (!evt.start) return false;
    var evtDate = evt.start.slice(0, 10);
    return evtDate >= todayStr && evtDate <= weekAheadStr;
  });

  filtered.sort(function(a, b) {
    return (a.start || '').localeCompare(b.start || '');
  });

  return filtered;
}

function unfoldLines(data) {
  return data.replace(/\r\n /g, '').replace(/\r\n\t/g, '').replace(/\r/g, '').split('\n');
}

function parseLine(line) {
  var colonIdx = line.indexOf(':');
  if (colonIdx === -1) return { key: '', params: '', value: '' };
  var left = line.slice(0, colonIdx);
  var value = line.slice(colonIdx + 1);
  var semiIdx = left.indexOf(';');
  if (semiIdx === -1) return { key: left.toUpperCase(), params: '', value: value };
  return { key: left.slice(0, semiIdx).toUpperCase(), params: left.slice(semiIdx + 1), value: value };
}

function parseICalDate(value, params) {
  if (/^\d{8}$/.test(value)) {
    return value.slice(0,4) + '-' + value.slice(4,6) + '-' + value.slice(6,8);
  }
  if (/^\d{8}T\d{6}/.test(value)) {
    var y = value.slice(0,4), m = value.slice(4,6), d = value.slice(6,8);
    var hh = value.slice(9,11), mm = value.slice(11,13), ss = value.slice(13,15);
    var isUTC = value.endsWith('Z');
    if (isUTC) {
      var dt = new Date(Date.UTC(+y, +m-1, +d, +hh, +mm, +ss));
      return dt.toISOString();
    }
    return y + '-' + m + '-' + d + 'T' + hh + ':' + mm + ':' + ss;
  }
  return value;
}

function isDateOnly(value, params) {
  if (params && params.toUpperCase().indexOf('VALUE=DATE') !== -1) return true;
  return /^\d{8}$/.test(value);
}

function unescapeIcal(str) {
  return str.replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

function expandRecurrence(evt, startRange, endRange) {
  var instances = [];
  var rule = parseRRule(evt.recurrence);
  if (!rule || !evt.start) return [evt];

  var baseDate = new Date(evt.start.slice(0, 10) + 'T12:00:00Z');
  var rangeStart = new Date(startRange + 'T00:00:00Z');
  var rangeEnd = new Date(endRange + 'T23:59:59Z');
  var until = rule.until ? new Date(rule.until + 'T23:59:59Z') : new Date(rangeEnd);
  var count = rule.count || 1000;
  var interval = rule.interval || 1;
  var baseTime = evt.start.length > 10 ? evt.start.slice(10) : '';
  var duration = getDurationMs(evt.start, evt.end);

  var current = new Date(baseDate);
  var generated = 0;

  for (var i = 0; i < 2000 && current <= until && current <= rangeEnd && generated < count; i++) {
    if (current >= rangeStart && current <= rangeEnd) {
      var dateStr = current.toISOString().slice(0, 10);
      var newStart = baseTime ? dateStr + baseTime : dateStr;
      var newEnd = (duration && evt.end) ? computeEnd(newStart, duration) : evt.end;
      var copy = {};
      for (var prop in evt) { copy[prop] = evt[prop]; }
      copy.start = newStart;
      copy.end = newEnd;
      copy.recurrence = null;
      instances.push(copy);
    }
    generated++;
    current = advanceDate(current, rule.freq, interval);
    if (current > rangeEnd) break;
  }

  return instances;
}

function parseRRule(rrule) {
  if (!rrule) return null;
  var parts = {};
  var pieces = rrule.split(';');
  for (var i = 0; i < pieces.length; i++) {
    var kv = pieces[i].split('=');
    if (kv[0] && kv[1]) parts[kv[0].toUpperCase()] = kv[1];
  }
  return {
    freq: parts.FREQ || 'YEARLY',
    interval: parseInt(parts.INTERVAL) || 1,
    until: parts.UNTIL ? parseICalDate(parts.UNTIL, '') : null,
    count: parts.COUNT ? parseInt(parts.COUNT) : null,
    byday: parts.BYDAY || null,
  };
}

function advanceDate(date, freq, interval) {
  var d = new Date(date);
  if (freq === 'DAILY') { d.setDate(d.getDate() + interval); }
  else if (freq === 'WEEKLY') { d.setDate(d.getDate() + 7 * interval); }
  else if (freq === 'MONTHLY') { d.setMonth(d.getMonth() + interval); }
  else if (freq === 'YEARLY') { d.setFullYear(d.getFullYear() + interval); }
  return d;
}

function getDurationMs(start, end) {
  if (!start || !end) return 0;
  return new Date(end).getTime() - new Date(start).getTime();
}

function computeEnd(start, durationMs) {
  var d = new Date(start);
  d.setTime(d.getTime() + durationMs);
  return d.toISOString();
}
