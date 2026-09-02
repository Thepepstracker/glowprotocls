// Glow Bioresearch — masked-checkout settlement poll (Netlify Function, Node).
// Server-to-server: asks the parent whether a session is paid. The browser cannot influence the answer;
// the parent's signed reply is the source of truth. Secret stays server-side.
const crypto = require('crypto');
const PARENT = (process.env.MAEF_PARENT || 'https://glowteam.store').replace(/\/+$/, '');
const SECRET = process.env.MAEF_PARENT_SECRET || '';

exports.handler = async (event) => {
  const H = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: H, body: '{"error":"method"}' };
  if (!SECRET) return { statusCode: 500, headers: H, body: '{"error":"not_configured"}' };
  let inp; try { inp = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, headers: H, body: '{"error":"bad_json"}' }; }
  const token = String(inp.session_token || '').slice(0, 200);
  if (!token) return { statusCode: 400, headers: H, body: '{"error":"token"}' };

  const body = JSON.stringify({ timestamp: Math.floor(Date.now() / 1000), session_token: token });
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('hex');
  let j = null;
  try {
    const r = await fetch(PARENT + '/wp-json/maef/v1/embed-status', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MAEF-Signature': sig }, body,
    });
    j = await r.json().catch(() => null);
  } catch { return { statusCode: 502, headers: H, body: '{"error":"unreachable"}' }; }

  // relay ONLY the paid flag + amount + a transaction id (never any parent/child identifying field)
  const out = { paid: !!(j && j.paid), amount: j && j.amount ? Number(j.amount) : 0, transId: j && j.transId ? String(j.transId) : '' };
  return { statusCode: 200, headers: H, body: JSON.stringify(out) };
};
