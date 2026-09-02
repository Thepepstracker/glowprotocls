/* Glow Bioresearch — masked-checkout session mint (Netlify Function, Node).
 *
 * Holds the shared secret (env MAEF_PARENT_SECRET) and signs the embed-session handshake, so the secret
 * never reaches client-side JS. Two jobs, in this order:
 *   1. PRICE the order here, from catalog.json — the browser sends slugs and quantities, never money.
 *   2. Hand the PARENT numbers only: ordinals, quantities and unit cents. No name, no slug, no domain,
 *      no coupon code, no buyer. Everything identifying stops at this function.
 */
'use strict';
const crypto = require('crypto');
const { priceOrder, cents } = require('./lib/pricing.js');
const catalog = require('../../catalog.json');

const PARENT = (process.env.MAEF_PARENT || 'https://glowteam.store').replace(/\/+$/, '');
const SECRET = process.env.MAEF_PARENT_SECRET || '';
const hmac = (body) => crypto.createHmac('sha256', SECRET).update(body).digest('hex');

exports.handler = async (event) => {
  const H = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: H, body: '{"error":"method"}' };
  if (!SECRET) return { statusCode: 500, headers: H, body: '{"error":"not_configured"}' };

  let inp;
  try { inp = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, headers: H, body: '{"error":"bad_json"}' }; }

  const mode = inp.mode === 'wallet' ? 'wallet' : 'card';
  const ref = String(inp.order_ref || '').replace(/[^A-Za-z0-9\-]/g, '').slice(0, 32) || ('g' + Date.now().toString(36));
  const returnUrl = String(inp.return_url || '').slice(0, 300);

  // ── price it here. The client's numbers, if it sent any, are ignored. ──────────────────────────
  const o = priceOrder(catalog, Array.isArray(inp.lines) ? inp.lines.slice(0, 60) : [], String(inp.code || '').slice(0, 40));
  if (!o.lines.length || o.total_cents <= 0) return { statusCode: 400, headers: H, body: '{"error":"empty_cart"}' };

  // ── the opaque cart the parent sees: ordinals + qty + unit cents, nothing else. ────────────────
  const cart = o.lines.map((l, i) => ({ g: i, v: 0, q: l.qty, u: cents(l.unit) }))
                      .filter((l) => l.u > 0 && l.q > 0).slice(0, 60);

  const body = JSON.stringify({
    timestamp: Math.floor(Date.now() / 1000),
    jti: 'g' + crypto.randomBytes(8).toString('hex'),
    total: o.total, subtotal: o.subtotal, shipping: o.shipping,
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

  const quote = { subtotal: o.subtotal, shipping: o.shipping, discount: o.discount, saved: o.saved, total: o.total, code: o.code, dropped: o.dropped };
  if (o.dropped > 0) return { statusCode: 409, headers: H, body: JSON.stringify({ error: 'cart_unpriced', dropped: o.dropped }) };

  if (mode === 'wallet') {
    const url = PARENT + '/secure-wallet/#t=' + encodeURIComponent(token) + '&a=' + o.total_cents + '&r=' + encodeURIComponent(returnUrl);
    return { statusCode: 200, headers: H, body: JSON.stringify({ session_token: token, wallet_url: url, amount: o.total, quote }) };
  }
  const ftExp = Math.floor(Date.now() / 1000) + 900;
  const frameTicket = ftExp + '.' + crypto.createHmac('sha256', SECRET).update('maef-sq-frame|' + ftExp).digest('hex');
  return {
    statusCode: 200, headers: H,
    body: JSON.stringify({ session_token: token, embed_pay: PARENT + '/secure-card/', frame_ticket: frameTicket, amount: o.total, quote }),
  };
};
