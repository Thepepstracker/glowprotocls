/* Glow Lab Protocols — masked card checkout (enhances the existing #order checkout).
 * Buyer types their card on the PARENT origin (inline iframe from glowteam.store) — this site never
 * sees the card or the charge. Numbers only leave the browser (via our own Netlify function, which holds
 * the secret). Two buttons, in order: (1) Card inline, (2) Apple Pay / Google Pay / Pay Later (redirect).
 * The real order is emailed to fulfilment (Netlify form) so it can be shipped; the processor never sees it.
 */
(function () {
  var PARENT = 'https://glowteam.store';
  var FN = '/.netlify/functions/';
  var SHIP_FREE_OVER = 250, SHIP_FLAT = 15;   // matches the storefront's stated policy

  function money(n) { return '$' + Number(n).toFixed(2); }
  function cents(n) { return Math.max(0, Math.round(Number(n) * 100)); }

  function readCart() {
    var GB = window.__GB; if (!GB) return null;
    var cart = GB.cart || {}, sz = window.__GBSIZE || {}, ex = window.__GBEXTRA || {}, items = [], gi = 0;
    Object.keys(cart).forEach(function (slug) {
      var p = GB.bySlug(slug); if (!p) return;
      var price = (sz[slug] && sz[slug].price != null) ? sz[slug].price : p.price; if (price == null) return;
      items.push({ name: p.name + (sz[slug] ? ' (' + sz[slug].size + ')' : ''), dose: p.dose || '', qty: cart[slug], price: price, g: gi++, v: 0 });
    });
    Object.keys(ex).forEach(function (k) { var e = ex[k]; if (!e || e.price == null) return;
      items.push({ name: e.name, dose: e.size || '', qty: e.qty || 1, price: e.price, g: gi++, v: 0 }); });
    return items;
  }

  function enhance(form) {
    if (form.getAttribute('data-gb') === '1') return;
    form.setAttribute('data-gb', '1');
    var items = readCart(); if (!items || !items.length) return;
    var sub = items.reduce(function (a, it) { return a + it.price * it.qty; }, 0);
    var ship = sub >= SHIP_FREE_OVER ? 0 : SHIP_FLAT;
    var total = sub + ship;

    // rewrite the "coming soon" sub-heading
    var subEl = form.querySelector('.sub'); if (subEl) subEl.textContent = 'Enter your details and pay securely by card or wallet. Your card is handled on our encrypted payment page.';

    // add shipping-address fields (for card verification + shipping) before the notes field
    var notes = form.querySelector('[name="notes"]');
    var addr = document.createElement('div');
    addr.innerHTML =
      '<div class="field"><label>Shipping address</label><input required name="address"></div>' +
      '<div class="field" style="display:flex;gap:10px"><span style="flex:2"><label>City</label><input required name="city"></span>' +
      '<span style="flex:1"><label>State</label><input required name="state" maxlength="2" placeholder="GA"></span>' +
      '<span style="flex:1"><label>ZIP</label><input required name="zip"></span></div>';
    if (notes && notes.closest('.field')) form.insertBefore(addr, notes.closest('.field'));
    else form.appendChild(addr);

    // order summary
    var sumEl = document.createElement('div');
    sumEl.className = 'gbpay-sum';
    sumEl.style.cssText = 'margin:8px 0 18px;font-size:14px;color:#6f6a61';
    sumEl.innerHTML = '<div style="display:flex;justify-content:space-between"><span>Subtotal</span><span>' + money(sub) + '</span></div>' +
      '<div style="display:flex;justify-content:space-between"><span>Shipping</span><span>' + (ship ? money(ship) : 'Free') + '</span></div>' +
      '<div style="display:flex;justify-content:space-between;font-weight:700;color:#1b1b1b;border-top:1px solid #ece5d7;margin-top:6px;padding-top:8px"><span>Total</span><span>' + money(total) + '</span></div>';

    // replace the submit button with our pay area
    var btn = form.querySelector('button');
    var pay = document.createElement('div'); pay.id = 'gb-pay';
    if (btn) { btn.parentNode.insertBefore(sumEl, btn); btn.parentNode.insertBefore(pay, btn); btn.remove(); }
    else { form.appendChild(sumEl); form.appendChild(pay); }

    // style
    if (!document.getElementById('gbpay-css')) {
      var st = document.createElement('style'); st.id = 'gbpay-css';
      st.textContent =
        '.gbpay-btn{display:block;width:100%;padding:15px;border:0;border-radius:4px;background:#1b1b1b;color:#fff;font:600 15px/1 inherit;letter-spacing:.04em;cursor:pointer;margin:0 0 10px;transition:background .2s}' +
        '.gbpay-btn:hover{background:#c9a24b}.gbpay-btn[disabled]{opacity:.6;cursor:default}' +
        '.gbpay-btn-alt{background:#fff;color:#1b1b1b;border:1px solid #1b1b1b}.gbpay-btn-alt:hover{background:#faf7f1;color:#1b1b1b}' +
        '.gbpay-note{font-size:13px;text-align:center;margin-top:8px;color:#6f6a61;min-height:18px}' +
        '#gb-pay iframe{width:100%;height:230px;border:1px solid #ece5d7;border-radius:8px;display:none;margin-bottom:10px}';
      document.head.appendChild(st);
    }
    mount(pay, form, items, sub, ship, total);
  }

  function mount(root, form, items, sub, ship, total) {
    var order_ref = 'g' + Date.now().toString(36);
    var cardBtn = el('button', 'gbpay-btn', 'Pay by card');
    var boot = el('div', 'gbpay-note', ''); boot.style.display = 'none';
    var frame = document.createElement('iframe'); frame.title = 'Card details'; frame.setAttribute('allow', 'payment'); frame.setAttribute('referrerpolicy', 'no-referrer');
    var walletBtn = el('button', 'gbpay-btn gbpay-btn-alt', 'Apple Pay · Google Pay · Pay Later');
    var note = el('div', 'gbpay-note', '');
    root.appendChild(cardBtn); root.appendChild(boot); root.appendChild(frame); root.appendChild(walletBtn); root.appendChild(note);

    function say(t, err) { note.textContent = t || ''; note.style.color = err ? '#b0392b' : '#6f6a61'; }
    function billing() {
      var q = function (n) { var e = form.querySelector('[name="' + n + '"]'); return e ? e.value.trim() : ''; };
      var nm = q('name').split(' ');
      return { email: q('email'), first_name: nm[0] || '', last_name: nm.slice(1).join(' '), address_1: q('address'), city: q('city'), state: q('state'), postcode: q('zip'), country: 'US' };
    }
    function valid() { return form.reportValidity && form.reportValidity(); }
    var payload = { total_cents: cents(total), subtotal_cents: cents(sub), shipping_cents: cents(ship),
      cart: items.map(function (it) { return { g: it.g, v: it.v, q: it.qty, u: cents(it.price) }; }), order_ref: order_ref };

    // fulfilment: email the REAL order to the store (Netlify form) so it can be shipped
    function notifyFulfilment(b) {
      try {
        var body = items.map(function (it) { return it.qty + ' x ' + it.name + ' (' + it.dose + ') ' + money(it.price); }).join('\n');
        var data = new URLSearchParams();
        data.append('form-name', 'gb-orders');
        data.append('order-ref', order_ref); data.append('name', (b.first_name + ' ' + b.last_name).trim());
        data.append('email', b.email); data.append('total', money(total));
        data.append('ship-to', b.address_1 + ', ' + b.city + ', ' + b.state + ' ' + b.postcode);
        data.append('items', body);
        fetch('/', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: data.toString() });
      } catch (e) {}
    }

    function done() {
      notifyFulfilment(billing());
      var c = document.querySelector('#main .cart .wrap') || document.getElementById('main');
      if (c) c.innerHTML = '<div style="max-width:600px;margin:40px auto;text-align:center"><h1 class="serif" style="font-size:38px">Thank you — your order is confirmed.</h1>' +
        '<p style="color:#6f6a61;margin:14px 0 24px">Order <b>' + order_ref + '</b>. A confirmation is on its way, and we\'ll ship it to you shortly.</p>' +
        '<a class="btn" href="#" onclick="location.hash=\'\'">Back to catalog</a></div>';
      window.scrollTo(0, 0);
    }

    cardBtn.addEventListener('click', function () {
      if (!valid()) return;
      cardBtn.disabled = true; walletBtn.disabled = true; boot.style.display = 'block'; say('Loading secure card field…');
      var b = billing();
      fetch(FN + 'pay-session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ mode: 'card', return_url: location.origin + '/#order' }, payload)) })
        .then(function (r) { return r.json(); }).then(function (d) {
          if (!d.session_token) { say('We could not start the payment. Please try again.', true); cardBtn.disabled = false; walletBtn.disabled = false; boot.style.display = 'none'; return; }
          window.__gbInit = { type: 'maef-init', amount: d.amount, sessionToken: d.session_token, billing: b, hideButton: true };
          window.__gbSess = d.session_token;
          frame.addEventListener('load', function () { post({ type: 'maef-mount', hideButton: true }); });
          frame.src = d.embed_pay + '?t=' + encodeURIComponent(d.frame_ticket);
        }).catch(function () { say('We could not reach the payment service. Please try again.', true); cardBtn.disabled = false; walletBtn.disabled = false; boot.style.display = 'none'; });
    });
    function post(m) { try { frame.contentWindow && frame.contentWindow.postMessage(m, PARENT); } catch (e) {} }

    if (!window.__gbBound) {
      window.__gbBound = true;
      window.addEventListener('message', function (e) {
        if (e.origin !== PARENT) return;
        var m = e.data || {};
        if (m.type === 'maef-ready') { boot.style.display = 'none'; frame.style.display = 'block'; if (window.__gbInit) post(window.__gbInit); }
        else if (m.type === 'maef-size' && typeof m.h === 'number') { frame.style.height = Math.min(420, Math.max(58, Math.ceil(m.h))) + 'px'; }
        else if (m.type === 'maef-result') {
          if (m.status === 'approved') {
            say('Payment approved — confirming your order…');
            fetch(FN + 'pay-status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_token: window.__gbSess }) })
              .then(function (r) { return r.json(); }).then(function () { done(); }).catch(function () { done(); });
          } else if (m.status === 'review') { done(); }
          else if (m.status === 'declined') { say('Your card was declined. Please try another card.', true); }
          else { say('We could not complete that payment. Please try again.', true); }
        } else if (m.type === 'maef-error') { say('Please check your card details and try again.', true); }
      });
    }

    walletBtn.addEventListener('click', function () {
      if (!valid()) return;
      walletBtn.disabled = true; cardBtn.disabled = true; say('Opening secure wallet…');
      notifyFulfilment(billing());
      fetch(FN + 'pay-session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ mode: 'wallet', return_url: location.origin + '/#order' }, payload)) })
        .then(function (r) { return r.json(); }).then(function (d) {
          if (d.wallet_url) location.href = d.wallet_url; else { say('Wallet unavailable — please pay by card.', true); walletBtn.disabled = false; cardBtn.disabled = false; }
        }).catch(function () { say('Could not open the wallet — please pay by card.', true); walletBtn.disabled = false; cardBtn.disabled = false; });
    });
  }

  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }

  // watch for the checkout form appearing (SPA re-renders #main on route change)
  function injectCheckout() {
    var main = document.getElementById('main'); if (!main || main.querySelector('.orderform')) return;
    main.innerHTML = '<section class="cart"><div class="wrap"><h1 class="serif" style="text-align:center;font-size:40px;margin-bottom:6px">Your Order</h1>' +
      '<form class="orderform" onsubmit="return false"><h2 class="serif">Your Details</h2><p class="sub"></p>' +
      '<div class="field"><label>Full Name</label><input required name="name"></div>' +
      '<div class="field"><label>Email</label><input required type="email" name="email"></div>' +
      '<div class="field"><label>Notes (optional)</label><textarea name="notes" rows="3"></textarea></div>' +
      '<button class="btn" style="width:100%">Submit Order</button>' +
      '<p class="ruo" style="text-align:center;margin-top:14px">Research use only — not for human consumption.</p></form></div></section>';
    var f = main.querySelector('.orderform'); if (f) enhance(f);
  }
  function scan() {
    if (location.hash.replace(/^#/, '') !== 'order') return;
    var f = document.querySelector('.orderform');
    if (f) { enhance(f); return; }
    var items = readCart(); if (items && items.length) injectCheckout();
  }
  var mo = new MutationObserver(scan);
  document.addEventListener('DOMContentLoaded', function () {
    var main = document.getElementById('main'); if (main) mo.observe(main, { childList: true, subtree: true });
    scan();
  });
  window.addEventListener('hashchange', function () { setTimeout(scan, 30); });
})();
