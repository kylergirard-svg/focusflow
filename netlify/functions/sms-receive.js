exports.handler = async function(event, context) {
  const headers = {
    'Content-Type': 'text/xml',
  };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    var params = new URLSearchParams(event.body);
    var from = params.get('From') || '';
    var body = (params.get('Body') || '').trim();
    var messageSid = params.get('MessageSid') || '';

    if (!body) {
      return {
        statusCode: 200, headers: headers,
        body: twiml('Empty message received. Text a task to add it to Focus Flow.'),
      };
    }

    var lower = body.toLowerCase();

    if (lower === 'stop') {
      return { statusCode: 200, headers: headers, body: twiml('You have been unsubscribed from Focus Flow reminders. Text START to re-subscribe.') };
    }

    if (lower === 'start') {
      return { statusCode: 200, headers: headers, body: twiml('Welcome back to Focus Flow! You will receive reminders again.') };
    }

    if (lower === 'help') {
      return {
        statusCode: 200, headers: headers,
        body: twiml(
          'Focus Flow SMS Commands:\n' +
          '- Text any task to add it to your inbox\n' +
          '- "ok" or "done" = acknowledge morning reminder\n' +
          '- "help" = this message\n' +
          '- "stop" = unsubscribe from reminders'
        ),
      };
    }

    if (lower === 'ok' || lower === 'done' || lower === 'got it') {
      return {
        statusCode: 200, headers: headers,
        body: twiml('Acknowledged! Have a great day.'),
      };
    }

    var items = body.split(/[,\n]+/).map(function(s) { return s.trim(); }).filter(function(s) { return s.length > 0; });
    var count = items.length;

    var reply;
    if (count === 1) {
      reply = 'Got it: "' + body + '"\n\nOpen Focus Flow to sort it into your task list.';
    } else {
      reply = 'Got ' + count + ' items captured.\n\nOpen Focus Flow to sort them into your task list.';
    }

    return { statusCode: 200, headers: headers, body: twiml(reply) };
  } catch (err) {
    return {
      statusCode: 200, headers: headers,
      body: twiml('Something went wrong, but your message was received. Try again or open Focus Flow directly.'),
    };
  }
};

function twiml(message) {
  var escaped = message
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return '<?xml version="1.0" encoding="UTF-8"?><Response><Message>' + escaped + '</Message></Response>';
}
