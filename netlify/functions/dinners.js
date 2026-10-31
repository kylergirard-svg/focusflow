// Netlify serverless function: reads the published "Weekday Dinners" Google Doc
// and returns { dinners: [{ date: 'YYYY-MM-DD', text }] }.
// Set DINNERS_DOC_URL in Netlify to the doc's "Publish to web" link
// (looks like https://docs.google.com/document/d/e/2PACX-.../pub).
// Expected lines in the doc: "Mon, Nov 2: Broccoli pasta and salad"
exports.handler = async function(event, context) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const docUrl = (process.env.DINNERS_DOC_URL || '').trim();
  if (!docUrl) return { statusCode: 500, headers, body: JSON.stringify({ error: 'DINNERS_DOC_URL not configured' }) };
  if (!/^https:\/\/docs\.google\.com\/document\/d\/e\/[A-Za-z0-9_-]+\/pub/.test(docUrl)) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'DINNERS_DOC_URL must be a "Publish to web" link' }) };
  }

  try {
    const response = await fetch(docUrl);
    if (!response.ok) throw new Error('Failed to fetch doc (' + response.status + ')');
    const html = await response.text();
    return { statusCode: 200, headers, body: JSON.stringify({ dinners: parseDinners(html, new Date()) }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

function decodeEntities(str) {
  return str
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, function(_, n) { return String.fromCharCode(parseInt(n, 10)); })
    .replace(/&#x([0-9a-f]+);/gi, function(_, n) { return String.fromCharCode(parseInt(n, 16)); })
    .replace(/&(mdash|ndash|rsquo|lsquo|rdquo|ldquo|hellip);/g, function(_, n) {
      return { mdash: '\u2014', ndash: '\u2013', rsquo: '\u2019', lsquo: '\u2018', rdquo: '\u201d', ldquo: '\u201c', hellip: '\u2026' }[n];
    })
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

// Today's date in Central time
function todayParts(now) {
  const p = {};
  new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: 'numeric', day: 'numeric' })
    .formatToParts(now).forEach(function(x) { if (x.type !== 'literal') p[x.type] = +x.value; });
  return p;
}

function parseDinners(html, now) {
  const t = todayParts(now);
  const todayMs = Date.UTC(t.year, t.month - 1, t.day);
  const contentsMatch = html.match(/<div[^>]*id="contents"[^>]*>([\s\S]*)<\/div>/i);
  const body = contentsMatch ? contentsMatch[1] : html;

  // One entry per paragraph / list item / heading
  const blocks = body.split(/<\/(?:p|li|h[1-6]|div)>/i)
    .map(function(b) { return decodeEntities(b.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim(); })
    .filter(Boolean);

  const out = [];
  const re = /^(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*\.?,?\s+([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s*[:\u2013\u2014-]\s*(.+)$/i;
  blocks.forEach(function(line) {
    const m = line.match(re);
    if (!m) return;
    const month = MONTHS[m[1].toLowerCase().slice(0, 4)] || MONTHS[m[1].toLowerCase().slice(0, 3)];
    const day = parseInt(m[2], 10);
    if (!month || day < 1 || day > 31) return;
    // Pick the year that puts this date closest to today (handles December → January)
    let best = null;
    [t.year - 1, t.year, t.year + 1].forEach(function(y) {
      const diff = Math.abs(Date.UTC(y, month - 1, day) - todayMs);
      if (!best || diff < best.diff) best = { y: y, diff: diff };
    });
    const pad = function(n) { return String(n).padStart(2, '0'); };
    out.push({ date: best.y + '-' + pad(month) + '-' + pad(day), text: m[3].trim() });
  });
  return out;
}

exports.parseDinners = parseDinners;
