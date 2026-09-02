// Glow Bioresearch — masked-checkout session mint (Netlify Function, Node).
// Holds the shared secret (env var MAEF_PARENT_SECRET) and signs the embed-session handshake so the
// secret NEVER reaches client-side JS (Part 18). The browser sends NUMBERS ONLY — no product names,
// no domain, no card. Returns a session token + the parent card-iframe URL + a signed frame ticket.
const crypto = require('crypto');

const PARENT = (process.env.MAEF_PARENT || 'https://glowteam.store').replace(/\/+$/, '');
const SECRET = process.env.MAEF_PARENT_SECRET || '';

function hmac(body) { return crypto.createHmac('sha256', SECRET).update(body).digest('hex'); }

exports.handler = async (event) => {
  const H = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: H, body: '{"error":"method"}' };
  if (!SECRET) return { statusCode: 500, headers: H, body: '{"error":"not_configured"}' };

  let inp;
  try { inp = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, headers: H, body: '{"error":"bad_json"}' }; }

  // --- sanitise: accept ONLY numeric fields. Reject anything that could carry a name/domain. ---
  const cents = (n) => Math.max(0, Math.round(Number(n) || 0));
  const total = cents(inp.total_cents), subtotal = cents(inp.subtotal_cents), shipping = cents(inp.shipping_cents);
  const ref = String(inp.order_ref || '').replace(/[^A-Za-z0-9\-]/g, '').slice(0, 40) || ('g' + Date.now());
  const returnUrl = String(inp.return_url || '').slice(0, 300);
  const mode = inp.mode === 'wallet' ? 'wallet' : 'card';
  // opaque cart: [{g,v,q,u}] — ordinals + qty + unit cents ONLY. Drop any other keys the client sent.
  const cart = Array.isArray(inp.cart) ? inp.cart.slice(0, 60).map((it) => ({
    g: Math.max(0, parseInt(it.g, 10) || 0), v: Math.max(0, parseInt(it.v, 10) || 0),
    q: Math.max(1, parseInt(it.q, 10) || 1), u: cents(it.u),
  })).filter((it) => it.u > 0) : [];
  if (!cart.length) cart.push({ g: 0, v: 0, q: 1, u: total });
  if (total <= 0) return { statusCode: 400, headers: H, body: '{"error":"amount"}' };

  const body = JSON.stringify({
    timestamp: Math.floor(Date.now() / 1000),
    jti: 'g' + crypto.randomBytes(8).toString('hex'),
    total: total / 100, subtotal: subtotal / 100, shipping: shipping / 100,
    wc_order_id: ref, cart, utm_params: { child_order_ref: ref },
  });

  let j = null, code = 0;
  try {
    const r = await fetch(PARENT + '/wp-json/maef/v1/embed-session', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MAEF-Signature': hmac(body) }, body,
    });
    code = r.status; j = await r.json().catch(() => null);
  } catch { return { statusCode: 502, headers: H, body: '{"error":"unreachable"}' }; }

  const token = j && j.session_token ? String(j.session_token) : '';
  if (!token) return { statusCode: 502, headers: H, body: JSON.stringify({ error: 'mint', http: code }) };

  if (mode === 'wallet') {
    // top-level redirect target for Apple Pay / Google Pay / BNPL (leak-safe: parent's own origin)
    const url = PARENT + '/secure-wallet/#t=' + encodeURIComponent(token) + '&a=' + total + '&r=' + encodeURIComponent(returnUrl);
    return { statusCode: 200, headers: H, body: JSON.stringify({ session_token: token, wallet_url: url }) };
  }
  // card: signed frame ticket so /secure-card/ names this child only to a verified request
  const ftExp = Math.floor(Date.now() / 1000) + 900;
  const frameTicket = ftExp + '.' + crypto.createHmac('sha256', SECRET).update('maef-sq-frame|' + ftExp).digest('hex');
  return {
    statusCode: 200, headers: H,
    body: JSON.stringify({ session_token: token, embed_pay: PARENT + '/secure-card/', frame_ticket: frameTicket, amount: total / 100 }),
  };
};
