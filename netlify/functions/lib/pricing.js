/* Glow Lab Protocols — THE pricing engine.
 * One rule set, one place. tools/sync-catalog.mjs bakes the result into the storefront at build time,
 * so what the buyer sees on glowlabprotocols.com comes from catalog.json and nothing else.
 * Payment itself happens on glps.shop (WooCommerce) — this file never charges anything.
 * If you change a rule here, change it nowhere else.
 */
'use strict';

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const cents = (n) => Math.max(0, Math.round(Number(n) * 100));

/* Effective unit price for one regular price under one product's rules.
 * Precedence — first match wins, and it is deliberately strict:
 *   1. fixed        an explicit sale price the operator typed          ("Glow Eyes is $19.99 this week")
 *   2. pct          a per-product percentage                            ("BPC-157, 20% off")
 *   3. sitewide_pct the sitewide sale, for anything with no own rule    ("20% off everything")
 *   4. regular      no sale
 * A rule can only ever LOWER a price. A "sale" that raises one is a data error, not a sale, so it is
 * ignored rather than charged — the buyer must never pay more than the ticket because of a typo here.
 */
function effective(regular, rule, sitewidePct) {
  const reg = Number(regular);
  if (!isFinite(reg) || reg <= 0) return { now: null, was: null };
  const rl = rule || {};
  let now = reg;
  if (rl.fixed != null && isFinite(Number(rl.fixed))) now = Number(rl.fixed);
  else if (rl.pct != null && isFinite(Number(rl.pct)) && Number(rl.pct) > 0) now = reg * (1 - Number(rl.pct));
  else if (sitewidePct && isFinite(Number(sitewidePct)) && Number(sitewidePct) > 0) now = reg * (1 - Number(sitewidePct));
  now = r2(now);
  if (!(now > 0) || now >= reg) return { now: r2(reg), was: null };   // never above the ticket price
  return { now, was: r2(reg) };
}

/* The whole catalogue, priced. Returns a lookup the storefront bakes and the functions charge from. */
function priceCatalog(cat) {
  const site = Number((cat.sale && cat.sale.sitewide_pct) || 0);
  const bundlePct = Number((cat.sale && cat.sale.bundles_pct) || 0);
  const price = {};
  for (const slug of Object.keys(cat.products || {})) {
    const p = cat.products[slug];
    const e = effective(p.regular, p, site);
    const row = { now: e.now, was: e.was };
    if (p.badge) row.badge = String(p.badge);
    if (Array.isArray(p.sizes) && p.sizes.length) {
      row.sizes = p.sizes.map((z) => {
        const ez = effective(z.regular, p, site);      // a size inherits its product's rule
        return { s: String(z.s), now: ez.now, was: ez.was };
      });
    }
    price[slug] = row;
  }
  const bundles = {};
  for (const wc of Object.keys(cat.bundles || {})) {
    const b = cat.bundles[wc];
    const rule = { pct: b.pct != null ? b.pct : bundlePct, fixed: null };
    bundles[wc] = (b.sizes || []).map((z) => {
      const e = effective(z.regular, rule, 0);
      return { s: String(z.s), now: e.now, was: e.was };
    });
  }
  return { price, bundles };
}

/* Shipping, from the same file the prices come from. */
function shippingFor(subtotal, cat) {
  const sh = (cat && cat.shipping) || {};
  const flat = Number(sh.flat != null ? sh.flat : 15);
  const free = Number(sh.free_over != null ? sh.free_over : 250);
  return subtotal >= free ? 0 : r2(flat);
}

/* ── COUPONS ──────────────────────────────────────────────────────────────────────────────────────
 * Validated ONLY here, and only ever called server-side for the amount that is actually charged.
 * The browser may display a coupon's effect; it can never assert one.
 */
function couponList(cat) {
  // NOT from the catalogue file: this repository is public, so a code committed to it is a code
  // anyone can read before it launches. They come from the environment, server-side only.
  const raw = (typeof process !== 'undefined' && process.env && process.env.GLP_COUPONS) || '';
  if (raw) { try { const j = JSON.parse(raw); if (Array.isArray(j)) return j; } catch (e) { /* malformed: no coupons, never a crash */ } }
  return Array.isArray(cat && cat.coupons) ? cat.coupons : [];   // local/test only
}

function findCoupon(cat, code) {
  const want = String(code || '').trim().toUpperCase();
  if (!want) return null;
  return couponList(cat).find((c) => String(c.code || '').trim().toUpperCase() === want) || null;
}

function applyCoupon(cat, code, subtotal, shipping) {
  const sub = r2(subtotal);
  const out = { ok: false, code: '', reason: '', discount: 0, shipping: r2(shipping), subtotal: sub, label: '' };
  if (!String(code || '').trim()) { out.reason = 'empty'; return out; }
  const c = findCoupon(cat, code);
  if (!c) { out.reason = 'That code is not recognised.'; return out; }
  if (c.active === false) { out.reason = 'That code is no longer active.'; return out; }
  if (c.expires) {
    const end = Date.parse(String(c.expires).length <= 10 ? c.expires + 'T23:59:59Z' : c.expires);
    if (isFinite(end) && Date.now() > end) { out.reason = 'That code has expired.'; return out; }
  }
  const min = Number(c.min_subtotal || 0);
  if (min > 0 && sub < min) { out.reason = 'This code needs a subtotal of $' + min.toFixed(2) + ' or more.'; return out; }

  let discount = 0;
  const type = String(c.type || 'percent').toLowerCase();
  if (type === 'percent') discount = sub * (Number(c.value) / 100);
  else if (type === 'fixed') discount = Number(c.value);
  discount = Math.min(r2(discount), sub);                    // a coupon can never exceed the goods
  if (!(discount > 0) && !c.free_shipping) { out.reason = 'That code has no effect on this order.'; return out; }

  out.ok = true;
  out.code = String(c.code).trim().toUpperCase();
  out.discount = r2(discount);
  if (c.free_shipping) out.shipping = 0;
  out.label = type === 'percent' ? Number(c.value) + '% off' : '$' + Number(c.value).toFixed(2) + ' off';
  if (c.free_shipping) out.label += (discount > 0 ? ' + free shipping' : 'free shipping');
  return out;
}

/* Price a cart the buyer's browser proposed, from the catalogue — NOT from the numbers it sent.
 * `lines` are [{slug, size, qty}] for products and [{bundle, size, qty}] for bundles.
 * Anything the browser asks for that is not in the catalogue is dropped, never guessed.
 */
function priceCart(cat, lines) {
  const { price, bundles } = priceCatalog(cat);
  const out = [];
  for (const ln of (Array.isArray(lines) ? lines : []).slice(0, 60)) {
    const qty = Math.max(1, Math.min(99, parseInt(ln.qty, 10) || 1));
    if (ln.bundle != null) {
      const rows = bundles[String(ln.bundle)];
      if (!rows) continue;
      const row = ln.size ? rows.find((z) => z.s === String(ln.size)) : rows[0];
      if (!row || !(row.now > 0)) continue;
      out.push({ kind: 'bundle', key: String(ln.bundle), size: row.s, qty, unit: row.now });
    } else {
      const row = price[String(ln.slug || '')];
      if (!row) continue;
      let unit = row.now;
      if (ln.size && Array.isArray(row.sizes)) {
        const z = row.sizes.find((x) => x.s === String(ln.size));
        if (z) unit = z.now; else continue;             // an unknown size is a mismatch, not a default
      }
      if (!(unit > 0)) continue;
      out.push({ kind: 'product', key: String(ln.slug), size: ln.size ? String(ln.size) : '', qty, unit });
    }
  }
  const subtotal = r2(out.reduce((a, l) => a + l.unit * l.qty, 0));
  return { lines: out, subtotal };
}

/* Every distinct unit price in the catalogue. Used by the build summary as a sanity check. */
function priceLadder(cat) {
  const { price, bundles } = priceCatalog(cat);
  const set = new Set();
  for (const k of Object.keys(price)) {
    const r = price[k];
    if (r.now > 0) set.add(r.now);
    (r.sizes || []).forEach((z) => { if (z.now > 0) set.add(z.now); });
  }
  for (const k of Object.keys(bundles)) bundles[k].forEach((z) => { if (z.now > 0) set.add(z.now); });
  return [...set].sort((a, b) => a - b);
}


/* ── THE ORDER ────────────────────────────────────────────────────────────────────────────────────
 * One function, used by the build to compute the totals shown on the storefront. Payment happens on
 * glps.shop (WooCommerce), so these figures must match the WooCommerce prices — see catalog.json.
 *
 * A coupon is spread across the line unit prices rather than carried as a separate order-level field,
 * because the parent validates that the opaque cart lines sum to the signed subtotal to the cent. The
 * discount actually reported back is re-derived from the integers that survived rounding, so the
 * arithmetic on the buyer's screen always adds up exactly.
 */
function priceOrder(cat, rawLines, code) {
  const { lines, subtotal } = priceCart(cat, rawLines);
  const dropped = (Array.isArray(rawLines) ? rawLines.length : 0) - lines.length;
  const grossCents = lines.reduce((a, l) => a + cents(l.unit) * l.qty, 0);

  // what the same goods cost at the ticket (pre-sale) price — shown as "sale saving"
  const { price, bundles } = priceCatalog(cat);
  let regularCents = 0;
  for (const l of lines) {
    let was = null;
    if (l.kind === 'bundle') {
      const row = (bundles[l.key] || []).find((z) => z.s === l.size);
      was = row && row.was;
    } else {
      const row = price[l.key];
      if (row) was = (l.size && row.sizes) ? (row.sizes.find((z) => z.s === l.size) || {}).was : row.was;
    }
    regularCents += cents(was != null ? was : l.unit) * l.qty;
  }

  const shipping0 = shippingFor(grossCents / 100, cat);
  const coupon = applyCoupon(cat, code, grossCents / 100, shipping0);
  const discountAsked = coupon.ok ? cents(coupon.discount) : 0;
  const shippingCents = cents(coupon.ok ? coupon.shipping : shipping0);

  let out = lines;
  if (discountAsked > 0 && grossCents > 0) {
    const target = Math.max(0, grossCents - discountAsked);
    // largest line first, so the unavoidable rounding remainder lands on the smallest line
    const order = lines.map((l, i) => i).sort((a, b) => (cents(lines[b].unit) * lines[b].qty) - (cents(lines[a].unit) * lines[a].qty));
    const unitOut = new Array(lines.length);
    let left = target;
    order.forEach((idx, n) => {
      const l = lines[idx];
      let share;
      if (n === order.length - 1) share = left;
      else share = Math.round((cents(l.unit) * l.qty) * target / grossCents);
      let u = Math.max(1, Math.round(share / l.qty));
      unitOut[idx] = u;
      left -= u * l.qty;
    });
    out = lines.map((l, i) => Object.assign({}, l, { unit: unitOut[i] / 100 }));
  }

  const subtotalCents = out.reduce((a, l) => a + cents(l.unit) * l.qty, 0);
  const totalCents = subtotalCents + shippingCents;
  return {
    lines: out,
    subtotal: r2(subtotalCents / 100),
    shipping: r2(shippingCents / 100),
    discount: r2(Math.max(0, grossCents - subtotalCents) / 100),
    saved: r2(Math.max(0, regularCents - grossCents) / 100),
    total: r2(totalCents / 100),
    subtotal_cents: subtotalCents, shipping_cents: shippingCents, total_cents: totalCents,
    code: coupon.ok ? coupon.code : '',
    dropped: Math.max(0, dropped),
    coupon,
  };
}

module.exports = { couponList, r2, cents, effective, priceCatalog, shippingFor, applyCoupon, findCoupon, priceCart, priceLadder, priceOrder };
