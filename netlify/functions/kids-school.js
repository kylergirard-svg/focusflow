// Netlify serverless function: reads the published "Kids and School" Google Doc
// and returns its checklist items as { items: [{ text, done }] }.
// Set KIDS_SCHOOL_DOC_URL in Netlify to the doc's "Publish to web" link
// (looks like https://docs.google.com/document/d/e/2PACX-.../pub).
exports.handler = async function(event, context) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const docUrl = (process.env.KIDS_SCHOOL_DOC_URL || '').trim();
  if (!docUrl) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'KIDS_SCHOOL_DOC_URL not configured' }) };
  }
  // Only ever fetch a published Google Doc.
  if (!/^https:\/\/docs\.google\.com\/document\/d\/e\/[A-Za-z0-9_-]+\/pub/.test(docUrl)) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'KIDS_SCHOOL_DOC_URL must be a "Publish to web" link' }) };
  }

  try {
    const response = await fetch(docUrl);
    if (!response.ok) throw new Error('Failed to fetch doc (' + response.status + ')');
    const html = await response.text();
    const items = parsePublishedDoc(html);
    return { statusCode: 200, headers, body: JSON.stringify({ items: items }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};

function decodeEntities(str) {
  return str
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, function(_, n) { return String.fromCharCode(parseInt(n, 10)); })
    .replace(/&#x([0-9a-f]+);/gi, function(_, n) { return String.fromCharCode(parseInt(n, 16)); })
    .replace(/&(mdash|ndash|rsquo|lsquo|rdquo|ldquo|hellip);/g, function(_, n) {
      return { mdash: '\u2014', ndash: '\u2013', rsquo: '\u2019', lsquo: '\u2018', rdquo: '\u201d', ldquo: '\u201c', hellip: '\u2026' }[n];
    })
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// Google marks a checked checklist item by striking its text through, using a CSS class.
function parsePublishedDoc(html) {
  const struck = {};
  const styleBlocks = html.match(/<style[^>]*>[\s\S]*?<\/style>/gi) || [];
  styleBlocks.forEach(function(block) {
    const rules = block.match(/\.([A-Za-z0-9_-]+)\s*\{[^}]*\}/g) || [];
    rules.forEach(function(rule) {
      if (/text-decoration[^;}]*line-through/i.test(rule)) {
        const m = rule.match(/^\.([A-Za-z0-9_-]+)/);
        if (m) struck[m[1]] = true;
      }
    });
  });

  // Only read the document body, not Google's header/footer.
  const contentsMatch = html.match(/<div[^>]*id="contents"[^>]*>([\s\S]*)<\/div>/i);
  const body = contentsMatch ? contentsMatch[1] : html;

  const items = [];
  const liRe = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = liRe.exec(body)) !== null) {
    const inner = m[1];
    const text = decodeEntities(inner.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    let done = /text-decoration[^;"]*line-through/i.test(inner);
    if (!done) {
      const classAttrs = inner.match(/class="([^"]+)"/g) || [];
      done = classAttrs.some(function(attr) {
        return attr.replace(/^class="|"$/g, '').split(/\s+/).some(function(c) { return struck[c]; });
      });
    }
    items.push({ text: text, done: done });
    if (items.length >= 200) break;
  }
  return items;
}

exports.parsePublishedDoc = parsePublishedDoc;
