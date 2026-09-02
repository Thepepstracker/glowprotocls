/* Glow Lab Protocols — masked card checkout (enhances the existing #order checkout).
 *
 * The buyer types their card on the PARENT origin (an inline iframe from glowteam.store); this site
 * never sees a card number, a token or the charge. Only NUMBERS leave the browser, and they leave it
 * through our own Netlify function, which holds the shared secret.
 *
 * Two payment buttons, in this order, always: (1) Card, inline. (2) Apple Pay / Google Pay / Pay Later.
 *
 * Pricing is NOT decided here. The browser proposes a cart (slugs, sizes, quantities); the server
 * prices it from catalog.json and returns the totals shown below. A tampered page cannot pick its own
 * price, and — more to the point — the price on the product card and the price on the card statement
 * are computed by the same code.
 */
(function () {
  var PARENT = 'https://glowteam.store';
  var FN = '/.netlify/functions/';

  function money(n) { return '$' + Number(n).toFixed(2); }
  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }

  /* The cart, as the buyer built it. Sent to the server as slug/size/qty — never as a price. */
  function readCart() {
    var GB = window.__GB; if (!GB) return null;
    var cart = GB.cart || {}, sz = window.__GBSIZE || {}, ex = window.__GBEXTRA || {}, lines = [];
    Object.keys(cart).forEach(function (slug) {
      var p = GB.bySlug(slug); if (!p || !cart[slug]) return;
      var size = sz[slug] ? sz[slug].size : '';
      lines.push({ slug: slug, size: size, qty: cart[slug],
                   label: p.name + (size ? ' (' + size + ')' : ''), dose: p.dose || '' });
    });
    Object.keys(ex).forEach(function (k) {
      var e = ex[k]; if (!e) return;
      if (e.bundle != null) lines.push({ bundle: e.bundle, size: e.size || '', qty: e.qty || 1, label: e.name, dose: '' });
    });
    return lines;
  }

  /* Only ONE checkout is live at a time, but the SPA re-renders #main on every route change, so a new
   * one can replace it. The window-level message listener is bound once; it must always talk to the
   * CURRENT checkout, never the closure of a checkout the buyer has already navigated away from. */
  var ACTIVE = null;

  function enhance(form) {
    if (form.getAttribute('data-gb') === '1') return;
    form.setAttribute('data-gb', '1');
    var lines = readCart(); if (!lines || !lines.length) return;

    var subEl = form.querySelector('.sub');
    if (subEl) subEl.textContent = 'Enter your details and pay securely by card or wallet. Your card is handled on our encrypted payment page.';

    var notes = form.querySelector('[name="notes"]');
    var addr = document.createElement('div');
    addr.innerHTML =
      '<div class="field"><label>Shipping address</label><input required name="address"></div>' +
      '<div class="field" style="display:flex;gap:10px"><span style="flex:2"><label>City</label><input required name="city"></span>' +
      '<span style="flex:1"><label>State</label><input required name="state" maxlength="2" placeholder="GA"></span>' +
      '<span style="flex:1"><label>ZIP</label><input required name="zip"></span></div>';
    if (notes && notes.closest('.field')) form.insertBefore(addr, notes.closest('.field'));
    else form.appendChild(addr);

    var sumEl = el('div', 'gbpay-sum'); sumEl.innerHTML = '<div class="gbpay-row"><span>Subtotal</span><span>…</span></div>';
    var codeBox = buildCodeBox();
    var pay = el('div'); pay.id = 'gb-pay';

    var btn = form.querySelector('button');
    if (btn) { btn.parentNode.insertBefore(codeBox.root, btn); btn.parentNode.insertBefore(sumEl, btn); btn.parentNode.insertBefore(pay, btn); btn.remove(); }
    else { form.appendChild(codeBox.root); form.appendChild(sumEl); form.appendChild(pay); }

    injectCSS();
    mount(pay, form, lines, sumEl, codeBox);
  }

  function buildCodeBox() {
    var root = el('div', 'gbpay-code');
    var lab = el('label', null, 'Discount code');
    var row = el('div', 'gbpay-code-row');
    var input = document.createElement('input');
    input.type = 'text'; input.name = 'discount_code'; input.placeholder = 'Enter code';
    input.autocapitalize = 'characters'; input.autocomplete = 'off'; input.spellcheck = false;
    var apply = el('button', 'gbpay-code-btn', 'Apply'); apply.type = 'button';
    var msg = el('div', 'gbpay-code-msg', '');
    row.appendChild(input); row.appendChild(apply);
    root.appendChild(lab); root.appendChild(row); root.appendChild(msg);
    return { root: root, input: input, apply: apply, msg: msg };
  }

  function injectCSS() {
    if (document.getElementById('gbpay-css')) return;
    var st = document.createElement('style'); st.id = 'gbpay-css';
    st.textContent =
      '.gbpay-btn{display:block;width:100%;padding:15px;border:0;border-radius:4px;background:#1b1b1b;color:#fff;font:600 15px/1 inherit;letter-spacing:.04em;cursor:pointer;margin:0 0 10px;transition:background .2s}' +
      '.gbpay-btn:hover:not([disabled]){background:#c9a24b}.gbpay-btn[disabled]{opacity:.55;cursor:default}' +
      '.gbpay-btn-alt{background:#fff;color:#1b1b1b;border:1px solid #1b1b1b}.gbpay-btn-alt:hover:not([disabled]){background:#faf7f1;color:#1b1b1b}' +
      '.gbpay-note{font-size:13px;text-align:center;margin-top:8px;color:#6f6a61;min-height:18px}' +
      '#gb-pay iframe{width:100%;height:230px;border:1px solid #ece5d7;border-radius:8px;display:none;margin-bottom:12px;background:#fff}' +
      '.gbpay-sum{margin:8px 0 18px;font-size:14px;color:#6f6a61}' +
      '.gbpay-row{display:flex;justify-content:space-between;padding:1px 0}' +
      '.gbpay-row.total{font-weight:700;color:#1b1b1b;border-top:1px solid #ece5d7;margin-top:6px;padding-top:8px;font-size:16px}' +
      '.gbpay-row.save{color:#c0392b}' +
      '.gbpay-code{margin:14px 0 4px}.gbpay-code label{display:block;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#c9a24b;font-weight:700;margin-bottom:6px}' +
      '.gbpay-code-row{display:flex;gap:8px}' +
      '.gbpay-code-row input{flex:1;padding:12px;font-size:15px;border:1px solid #d9d2c4;border-radius:2px;background:#fff;font-family:inherit;text-transform:uppercase}' +
      '.gbpay-code-btn{padding:12px 20px;border:1px solid #1b1b1b;background:#fff;color:#1b1b1b;border-radius:2px;font:600 13px/1 inherit;letter-spacing:.08em;text-transform:uppercase;cursor:pointer}' +
      '.gbpay-code-btn[disabled]{opacity:.5;cursor:default}' +
      '.gbpay-code-msg{font-size:13px;margin-top:6px;min-height:17px}' +
      '.gbpay-code-msg.ok{color:#127c2b}.gbpay-code-msg.err{color:#b0392b}';
    document.head.appendChild(st);
  }

  function mount(root, form, lines, sumEl, codeBox) {
    var order_ref = 'g' + Date.now().toString(36);
    var cardBtn = el('button', 'gbpay-btn', 'Pay by card'); cardBtn.type = 'button';
    var frame = document.createElement('iframe');
    frame.title = 'Card details'; frame.setAttribute('allow', 'payment'); frame.setAttribute('referrerpolicy', 'no-referrer');
    var walletBtn = el('button', 'gbpay-btn gbpay-btn-alt', 'Apple Pay · Google Pay · Pay Later'); walletBtn.type = 'button';
    var note = el('div', 'gbpay-note', '');
    root.appendChild(cardBtn); root.appendChild(frame); root.appendChild(walletBtn); root.appendChild(note);

    var S = {                                       // this checkout's state — the listener reads THIS
      form: form, lines: lines, sumEl: sumEl, codeBox: codeBox, frame: frame,
      cardBtn: cardBtn, walletBtn: walletBtn, note: note, order_ref: order_ref,
      code: '', quote: null, session: null, stage: 'idle', done: false
    };
    ACTIVE = S;

    function say(t, err) { note.textContent = t || ''; note.style.color = err ? '#b0392b' : '#6f6a61'; }
    S.say = say;

    function renderSummary(q) {
      if (!q) return;
      var h = '<div class="gbpay-row"><span>Subtotal</span><span>' + money(q.subtotal) + '</span></div>';
      if (q.saved > 0) h += '<div class="gbpay-row save"><span>Sale saving</span><span>−' + money(q.saved) + '</span></div>';
      if (q.discount > 0) h += '<div class="gbpay-row save"><span>Discount' + (q.code ? ' (' + q.code + ')' : '') + '</span><span>−' + money(q.discount) + '</span></div>';
      h += '<div class="gbpay-row"><span>Shipping</span><span>' + (q.shipping > 0 ? money(q.shipping) : 'Free') + '</span></div>';
      h += '<div class="gbpay-row total"><span>Total</span><span>' + money(q.total) + '</span></div>';
      sumEl.innerHTML = h;
      if (S.stage === 'ready') cardBtn.textContent = 'Pay ' + money(q.total);
    }

    /* Every total on this page comes back from the server, priced from catalog.json. */
    function quote(code, cb) {
      fetch(FN + 'quote', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lines: S.lines.map(function (l) { return { slug: l.slug, bundle: l.bundle, size: l.size, qty: l.qty }; }), code: code || '' }) })
        .then(function (r) { return r.json(); })
        .then(function (q) {
          if (q && q.dropped > 0) { say('One item in your basket is no longer available at the listed price. Please remove it and try again.', true); cardBtn.disabled = true; walletBtn.disabled = true; }
          if (q && q.total != null) { S.quote = q; renderSummary(q); }
          if (cb) cb(q);
        })
        .catch(function () { if (cb) cb(null); });
    }
    quote('', null);

    codeBox.apply.addEventListener('click', function () {
      var code = (codeBox.input.value || '').trim().toUpperCase();
      if (!code) { codeBox.msg.className = 'gbpay-code-msg'; codeBox.msg.textContent = ''; return; }
      codeBox.apply.disabled = true; codeBox.msg.className = 'gbpay-code-msg'; codeBox.msg.textContent = 'Checking…';
      quote(code, function (q) {
        codeBox.apply.disabled = false;
        if (q && q.coupon && q.coupon.ok) {
          S.code = q.coupon.code;
          codeBox.msg.className = 'gbpay-code-msg ok';
          codeBox.msg.textContent = q.coupon.code + ' applied — ' + q.coupon.label + '.';
        } else {
          S.code = '';
          codeBox.msg.className = 'gbpay-code-msg err';
          codeBox.msg.textContent = (q && q.coupon && q.coupon.reason) || 'That code could not be applied.';
        }
        if (S.stage !== 'idle') resetCard();          // the amount moved — the mounted card frame is stale
      });
    });
    codeBox.input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); codeBox.apply.click(); } });

    function resetCard() {
      S.stage = 'idle'; S.session = null;
      frame.style.display = 'none'; frame.removeAttribute('src');
      cardBtn.disabled = false; walletBtn.disabled = false; cardBtn.textContent = 'Pay by card';
      say('');
    }

    function billing() {
      var q = function (n) { var e = form.querySelector('[name="' + n + '"]'); return e ? e.value.trim() : ''; };
      var nm = q('name').split(' ');
      return { email: q('email'), first_name: nm[0] || '', last_name: nm.slice(1).join(' '),
               address_1: q('address'), city: q('city'), state: q('state'), postcode: q('zip'), country: 'US' };
    }
    S.billing = billing;
    function valid() { return !form.reportValidity || form.reportValidity(); }

    /* The real order goes to fulfilment by e-mail (Netlify form). The processor never sees it. */
    function notifyFulfilment(status) {
      try {
        var b = billing(), q = S.quote || {};
        var body = S.lines.map(function (l) { return l.qty + ' x ' + l.label + (l.dose ? ' (' + l.dose + ')' : ''); }).join('\n');
        var data = new URLSearchParams();
        data.append('form-name', 'gb-orders');
        data.append('order-ref', S.order_ref);
        data.append('status', status);
        data.append('name', (b.first_name + ' ' + b.last_name).trim());
        data.append('email', b.email);
        data.append('total', money(q.total != null ? q.total : 0));
        data.append('discount', q.discount > 0 ? (S.code + ' −' + money(q.discount)) : '');
        data.append('ship-to', b.address_1 + ', ' + b.city + ', ' + b.state + ' ' + b.postcode);
        data.append('items', body);
        fetch('/', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: data.toString() });
      } catch (e) {}
    }
    S.notifyFulfilment = notifyFulfilment;

    S.done = function () {
      notifyFulfilment('PAID — card');
      var c = document.querySelector('#main .cart .wrap') || document.getElementById('main');
      if (c) c.innerHTML = '<div style="max-width:600px;margin:40px auto;text-align:center"><h1 class="serif" style="font-size:38px">Thank you — your order is confirmed.</h1>' +
        '<p style="color:#6f6a61;margin:14px 0 24px">Order <b>' + S.order_ref + '</b>. A confirmation is on its way, and we\'ll ship it to you shortly.</p>' +
        '<a class="btn" href="#" onclick="location.hash=\'\'">Back to catalog</a></div>';
      try { Object.keys(window.__GB.cart).forEach(function (k) { delete window.__GB.cart[k]; }); window.__GBEXTRA = {}; if (window.updateCartBtn) window.updateCartBtn(); } catch (e) {}
      window.scrollTo(0, 0);
    };

    /* ── the card button. Click 1 mounts the field; click 2 charges it. ─────────────────────────
     * The parent frame renders the card input and hides its own Pay control, because the contract is
     * that the EMBEDDER drives the charge (it is the side that knows the order is otherwise complete).
     * So this button has to send `maef-charge` — without it the buyer types a card into a field that
     * nothing can submit, which is exactly the dead end this replaces. */
    cardBtn.addEventListener('click', function () {
      if (S.stage === 'ready') { charge(); return; }
      if (S.stage === 'charging') return;
      if (!valid()) return;
      S.stage = 'loading';
      cardBtn.disabled = true; walletBtn.disabled = true; say('Loading secure card field…');
      fetch(FN + 'pay-session', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'card', code: S.code, order_ref: S.order_ref,
                               lines: S.lines.map(function (l) { return { slug: l.slug, bundle: l.bundle, size: l.size, qty: l.qty }; }),
                               return_url: location.origin + '/#order' }) })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (!d || !d.session_token) { say('We could not start the payment. Please try again.', true); resetCard(); return; }
          S.session = d.session_token;
          if (d.quote) { S.quote = d.quote; renderSummary(d.quote); }
          S.init = { type: 'maef-init', amount: d.amount, sessionToken: d.session_token, billing: billing(), hideButton: true };
          frame.addEventListener('load', function () { postToFrame({ type: 'maef-mount', hideButton: true }); });
          frame.src = d.embed_pay + '?t=' + encodeURIComponent(d.frame_ticket);
        })
        .catch(function () { say('We could not reach the payment service. Please try again.', true); resetCard(); });
    });

    function postToFrame(m) { try { frame.contentWindow && frame.contentWindow.postMessage(m, PARENT); } catch (e) {} }
    S.postToFrame = postToFrame;

    function charge() {
      if (!valid()) return;
      S.stage = 'charging';
      cardBtn.disabled = true; walletBtn.disabled = true; cardBtn.textContent = 'Processing…';
      say('Contacting your bank — please don\'t close this page.');
      postToFrame({ type: 'maef-charge' });
    }
    S.charge = charge;
    S.onReady = function () {
      if (S.stage === 'charging') return;
      S.stage = 'ready';
      frame.style.display = 'block';
      cardBtn.disabled = false; walletBtn.disabled = false;
      cardBtn.textContent = S.quote ? 'Pay ' + money(S.quote.total) : 'Pay now';
      say('Enter your card above, then press Pay.');
    };
    S.onDeclined = function (m) {
      S.stage = 'ready';
      cardBtn.disabled = false; walletBtn.disabled = false;
      cardBtn.textContent = S.quote ? 'Pay ' + money(S.quote.total) : 'Pay now';
      say(m, true);
    };

    walletBtn.addEventListener('click', function () {
      if (!valid()) return;
      walletBtn.disabled = true; cardBtn.disabled = true; say('Opening secure wallet…');
      notifyFulfilment('WALLET STARTED — confirm payment before shipping');
      fetch(FN + 'pay-session', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'wallet', code: S.code, order_ref: S.order_ref,
                               lines: S.lines.map(function (l) { return { slug: l.slug, bundle: l.bundle, size: l.size, qty: l.qty }; }),
                               return_url: location.origin + '/#order' }) })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d && d.wallet_url) location.href = d.wallet_url;
          else { say('Wallet unavailable — please pay by card.', true); walletBtn.disabled = false; cardBtn.disabled = false; }
        })
        .catch(function () { say('Could not open the wallet — please pay by card.', true); walletBtn.disabled = false; cardBtn.disabled = false; });
    });
  }

  /* One listener for the life of the page; it always addresses the checkout that is on screen now. */
  if (!window.__gbBound) {
    window.__gbBound = true;
    window.addEventListener('message', function (e) {
      if (e.origin !== PARENT) return;
      var S = ACTIVE; if (!S) return;
      var m = e.data || {};
      if (m.type === 'maef-ready') { if (S.init) S.postToFrame(S.init); S.onReady(); }
      else if (m.type === 'maef-size' && typeof m.h === 'number') { S.frame.style.height = Math.min(460, Math.max(58, Math.ceil(m.h))) + 'px'; }
      else if (m.type === 'maef-result') {
        if (m.status === 'approved' || m.status === 'review') {
          S.say('Payment approved — confirming your order…');
          fetch(FN + 'pay-status', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_token: S.session }) })
            .then(function (r) { return r.json(); }).then(function () { S.done(); }).catch(function () { S.done(); });
        } else if (m.status === 'declined') { S.onDeclined('Your card was declined. Please check the details or try another card.'); }
        else { S.onDeclined('We could not complete that payment. Please try again.'); }
      } else if (m.type === 'maef-error') {
        var why = { 'card-invalid': 'Please check your card number, expiry and CVV.', 'no-session': 'Your session expired — please press Pay by card again.',
                    'not-ready': 'The card field is still loading — one moment.', 'sdk': 'The payment field could not load. Please refresh and try again.' };
        S.onDeclined(why[m.reason] || 'Please check your card details and try again.');
      }
    });
  }

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
    var lines = readCart(); if (lines && lines.length) injectCheckout();
  }
  var mo = new MutationObserver(scan);
  document.addEventListener('DOMContentLoaded', function () {
    var main = document.getElementById('main'); if (main) mo.observe(main, { childList: true, subtree: true });
    scan();
  });
  window.addEventListener('hashchange', function () { setTimeout(scan, 30); });
})();
