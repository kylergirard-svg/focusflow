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
    let calendarSummary = '';
    if (calUrl) {
      try {
        const calRes = await fetch(calUrl);
        if (calRes.ok) {
          const icalData = await calRes.text();
          const todayEvents = parseTodayEvents(icalData);
          if (todayEvents.length > 0) {
            calendarSummary = '\n\n📅 Today:\n' + todayEvents.map(e => {
              const time = e.allDay ? 'All day' : e.time;
              return '• ' + e.title + (time ? ' (' + time + ')' : '');
            }).join('\n');
          } else {
            calendarSummary = '\n\n📅 No events on the family calendar today.';
          }
        }
      } catch (e) {
        calendarSummary = '';
      }
    }

    let inboxNote = '';
    try {
      const inboxCount = await getInboundCount(accountSid, authToken, twilioNumber);
      if (inboxCount > 0) {
        inboxNote = '\n\n📥 ' + inboxCount + ' item' + (inboxCount > 1 ? 's' : '') + ' in your SMS inbox waiting to be sorted.';
      }
    } catch (e) {}

    const dayName = new Date().toLocaleDateString('en-US', { timeZone: 'America/Chicago', weekday: 'long' });
    const message = 'Good morning ☀️ Happy ' + dayName + '.' + calendarSummary + inboxNote + '\n\nOpen Focus Flow to review your tasks and start your day.\n\nReply with a task to add it anytime.';

    await sendSMS(accountSid, authToken, twilioNumber, myNumber, message);
    return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: 'Morning SMS sent' }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};

async function sendSMS(accountSid, authToken, from, to, body) {
  const auth = btoa(accountSid + ':' + authToken);
  const response = await fetch(
    'https://api.twilio.com/2010-04-01/Accounts/' + accountSid + '/Messages.json',
    {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + auth,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, From: from, Body: body }),
    }
  );
  if (!response.ok) {
    const errData = await response.text();
    throw new Error('Twilio error: ' + errData);
  }
  return response.json();
}

async function getInboundCount(accountSid, authToken, twilioNumber) {
  const auth = btoa(accountSid + ':' + authToken);
  const since = new Date();
  since.setDate(since.getDate() - 7);
  const sinceStr = since.toISOString().slice(0, 10);
  const response = await fetch(
    'https://api.twilio.com/2010-04-01/Accounts/' + accountSid + '/Messages.json?To=' + encodeURIComponent(twilioNumber) + '&DateSent%3E=' + sinceStr + '&PageSize=50',
    { headers: { 'Authorization': 'Basic ' + auth } }
  );
  if (!response.ok) return 0;
  const data = await response.json();
  return (data.messages || []).length;
}

function parseTodayEvents(data) {
  const events = [];
  const lines = data.replace(/\r\n /g, '').replace(/\r\n\t/g, '').replace(/\r/g, '').split('\n');
  var current = null;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') current = {};
    else if (line === 'END:VEVENT' && current) {
      if (current.summary && current.dateStr === today && current.status !== 'CANCELLED') {
        events.push({ title: current.summary, time: current.time || null, allDay: current.allDay });
      }
      current = null;
    } else if (current) {
      const col = line.indexOf(':');
      if (col === -1) continue;
      const left = line.slice(0, col);
      const value = line.slice(col + 1);
      const key = left.split(';')[0].toUpperCase();
      if (key === 'SUMMARY') current.summary = value.replace(/\\n/g, ' ').replace(/\\,/g, ',');
      else if (key === 'STATUS') current.status = value;
      else if (key === 'DTSTART') {
        if (/^\d{8}$/.test(value)) {
          current.dateStr = value.slice(0,4) + '-' + value.slice(4,6) + '-' + value.slice(6,8);
          current.allDay = true;
        } else if (/^\d{8}T\d{6}/.test(value)) {
          const isUTC = value.endsWith('Z');
          const dt = isUTC
            ?
