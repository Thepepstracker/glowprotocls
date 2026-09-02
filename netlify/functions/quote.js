/* Glow Lab Protocols — price an order. The checkout shows what THIS returns, and /pay-session charges
 * what this returns, because both call the same priceOrder(). The browser never decides a price; it
 * proposes a cart (slug / size / quantity) and is told what that costs.
 * Nothing here reaches the parent or the gateway — it is a same-origin pricing call.
 */
'use strict';
const { priceOrder } = require('./lib/pricing.js');
const catalog = require('../../catalog.json');   // bundled at deploy: page and charge share one version

const H = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: H, body: '{"error":"method"}' };
  let inp;
  try { inp = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, headers: H, body: '{"error":"bad_json"}' }; }

  const lines = Array.isArray(inp.lines) ? inp.lines.slice(0, 60) : [];
  const code = String(inp.code || '').slice(0, 40);
  const o = priceOrder(catalog, lines, code);
  if (!o.lines.length) return { statusCode: 200, headers: H, body: JSON.stringify({ empty: true, subtotal: 0, shipping: 0, discount: 0, saved: 0, total: 0 }) };

  return {
    statusCode: 200, headers: H,
    body: JSON.stringify({
      subtotal: o.subtotal, shipping: o.shipping, discount: o.discount, saved: o.saved, total: o.total, dropped: o.dropped,
      code: o.code,
      coupon: { ok: o.coupon.ok, code: o.coupon.code, label: o.coupon.label, reason: o.coupon.reason },
    }),
  };
};
