exports.handler = async function(event, context) {
  var headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: headers, body: '' };
  }

  var accountSid = process.env.TWILIO_ACCOUNT_SID;
  var authToken = process.env.TWILIO_AUTH_TOKEN;
  var twilioNumber = process.env.TWILIO_PHONE_NUMBER;

  if (!accountSid || !authToken || !twilioNumber) {
    return { statusCode: 500, headers: headers, body: JSON.stringify({ error: 'Missing Twilio config' }) };
  }

  try {
    var since = new Date();
    since.setDate(since.getDate() - 14);
    var sinceStr = since.toISOString().slice(0, 10);

    var auth = btoa(accountSid + ':' + authToken);
    var response = await fetch(
      'https://api.twilio.com/2010-04-01/Accounts/' + accountSid + '/Messages.json?To=' + encodeURIComponent(twilioNumber) + '&DateSent%3E=' + sinceStr + '&PageSize=50',
      { headers: { 'Authorization': 'Basic ' + auth } }
    );

    if (!response.ok) {
      throw new Error('Failed to fetch messages from Twilio');
    }

    var data = await response.json();
    var messages = (data.messages || [])
      .filter(function(m) {
        var body = (m.body || '').trim().toLowerCase();
        return body !== 'ok' && body !== 'done' && body !== 'got it'
          && body !== 'stop' && body !== 'start' && body !== 'help'
          && body.length > 0;
      })
      .map(function(m) {
        return {
          sid: m.sid,
          from: m.from,
          body: m.body,
          dateSent: m.date_sent,
        };
      });

    return {
      statusCode: 200, headers: headers,
      body: JSON.stringify({ messages: messages }),
    };
  } catch (err) {
    return { statusCode: 500, headers: headers, body: JSON.stringify({ error: err.message }) };
  }
};
