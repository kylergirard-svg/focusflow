exports.handler = async function(event, context) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  const params = event.queryStringParameters || {};
  if (params.key !== (process.env.CRON_SECRET || 'focusflow')) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const twilioNumber = process.env.TWILIO_PHONE_NUMBER;
  const myNumber = process.env.MY_PHONE_NUMBER;
  const calUrl = process.env.GOOGLE_CAL_URL;

  if (!accountSid || !authToken || !twilioNumber || !myNumber) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Missing Twilio config' }) };
  }

  try {
    var tomorrowSummary = '';
    if (calUrl) {
      try {
        const calRes = await fetch(calUrl);
        if (calRes.ok) {
          const icalData = await calRes.text();
          const tomorrowEvents = parseTomorrowEvents(icalData);
          if (tomorrowEvents.length > 0) {
            tomorrowSummary = '\n\n📅 Tomorrow:\n' + tomorrowEvents.map(function(e) {
              var time = e.allDay ? 'All day' : e.time;
              return '• ' + e.title + (time ? ' (' + time + ')' : '');
            }).join('\n');
          }
        }
      } catch (e) {}
    }

    var message = 'Good evening 🌙\n\nQuick check-in before you wind down — anything left to capture?' + tomorrowSummary + '\n\nText any lingering thoughts now so they don\'t keep you up. Focus Flow will sort them in the morning.';

    var auth = btoa(accountSid + ':' + authToken);
    await fetch(
      'https://api.twilio.com/2010-04-01/Accounts/' + accountSid + '/Messages.json',
      {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + auth,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: myNumber, From: twilioNumber, Body: message }),
      }
    );

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: 'Evening SMS sent' }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};

function parseTomorrowEvents(data) {
  var events = [];
  var lines = data.replace(/\r\n /g, '').replace(/\r\n\t/g, '').replace(/\r/g, '').split('\n');
  var current = null;
  var tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  var tomorrowStr = tomorrow.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (line === 'BEGIN:VEVENT') current = {};
    else if (line === 'END:VEVENT' && current) {
      if (current.summary && current.dateStr === tomorrowStr && current.status !== 'CANCELLED') {
        events.push({ title: current.summary, time: current.time || null, allDay: current.allDay });
      }
      current = null;
    } else if (current) {
      var col = line.indexOf(':');
      if (col === -1) continue;
      var left = line.slice(0, col);
      var value = line.slice(col + 1);
      var key = left.split(';')[0].toUpperCase();
      if (key === 'SUMMARY') current.summary = value.replace(/\\n/g, ' ').replace(/\\,/g, ',');
      else if (key === 'STATUS') current.status = value;
      else if (key === 'DTSTART') {
        if (/^\d{8}$/.test(value)) {
          current.dateStr = value.slice(0,4) + '-' + value.slice(4,6) + '-' + value.slice(6,8);
          current.allDay = true;
        } else if (/^\d{8}T\d{6}/.test(value)) {
          var isUTC = value.endsWith('Z');
          var dt = isUTC
            ? new Date(Date.UTC(+value.slice(0,4), +value.slice(4,6)-1, +value.slice(6,8), +value.slice(9,11), +value.slice(11,13)))
            : new Date(+value.slice(0,4), +value.slice(4,6)-1, +value.slice(6,8), +value.slice(9,11), +value.slice(11,13));
          current.dateStr = dt.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
          current.time = dt.toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit', hour12: true });
          current.allDay = false;
        }
      }
    }
  }
  return events;
}
