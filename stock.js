/* stock.js — shows live "Sold out" status on the storefront.
 *
 * Reads current stock from glps.shop (the WooCommerce store that actually takes the orders) on every
 * page load, so nothing here ever needs editing by hand: a product shows SOLD OUT the moment its stock
 * hits zero there, and comes back on its own when it is restocked.
 *
 * Display only. It never changes a price. If glps.shop cannot be reached, it does nothing at all and the
 * page behaves exactly as it did before — unknown stock is always treated as in stock.
 */
(function () {
  'use strict';
  var API = 'https://glps.shop/wp-json/wc/store/v1/products';
  var Q = String.fromCharCode(63), AMP = String.fromCharCode(38);
  var inP = {};      // wc product id  -> true/false
  var inV = {};      // variation id   -> true/false
  var bySize = {};   // wc parent id   -> { "10 mg": true/false }
  var ready = false;
  var ES = /^es/i.test(document.documentElement.lang || '');
  var WORD = ES ? 'AGOTADO' : 'SOLD OUT';
  var WORD_S = ES ? 'Agotado' : 'Sold out';

  function P() { return (typeof PRODUCTS !== 'undefined' && PRODUCTS) || []; }
  function Bn() { return (typeof B !== 'undefined' && B) || []; }
  function find(slug) { var a = P(); for (var i = 0; i < a.length; i++) { if (a[i].slug === slug) return a[i]; } return null; }

  function sizeIn(v) { return inV[v] !== false; }
  function prodIn(p) {
    if (!p || !p.wc) return true;
    if (p.sizes && p.sizes.length) {
      for (var i = 0; i < p.sizes.length; i++) { if (sizeIn(p.sizes[i].v)) return true; }
      return false;
    }
    return inP[p.wc] !== false;
  }
  function bundleSizeIn(b, name) { var m = bySize[b.wc]; return !(m && m[name] === false); }
  function bundleIn(b) {
    if (!b || !b.wc) return true;
    if (inP[b.wc] === false && !bySize[b.wc]) return false;
    if (bySize[b.wc]) { for (var i = 0; i < b.sizes.length; i++) { if (bundleSizeIn(b, b.sizes[i][0])) return true; } return false; }
    return true;
  }

  function css() {
    if (document.getElementById('glp-stock-css')) return;
    var st = document.createElement('style');
    st.id = 'glp-stock-css';
    st.textContent = [
      '.card.glp-so .ph{position:relative}',
      '.card.glp-so .ph::after{content:"' + WORD + '";position:absolute;top:12px;left:12px;z-index:2;background:#1B1B1B;color:#fff;font:600 11px/1 -apple-system,system-ui,sans-serif;letter-spacing:.12em;padding:7px 10px;border-radius:3px}',
      '.card.glp-so .ph img{opacity:.5;filter:grayscale(.4)}',
      '.card.glp-so .cprice,.card.glp-so .cprice *,.card.glp-so .cview{color:#8A8A85!important}',
      '.glp-so-btn{background:#E7E6E1!important;color:#5E5E59!important;border-color:#E7E6E1!important;cursor:not-allowed!important;pointer-events:none;transition:none!important;opacity:1!important}',
      '.glp-bso{position:relative}',
      '.glp-bso::before{content:"' + WORD + '";position:absolute;top:12px;left:12px;z-index:2;background:#1B1B1B;color:#fff;font:600 11px/1 -apple-system,system-ui,sans-serif;letter-spacing:.12em;padding:7px 10px;border-radius:3px}',
      '.glp-bso>img{opacity:.5;filter:grayscale(.4)}'
    ].join('\n');
    document.head.appendChild(st);
  }

  function markOptions(sel, isIn) {
    var firstIn = -1, curOut = false;
    for (var i = 0; i < sel.options.length; i++) {
      var o = sel.options[i], ok = isIn(i);
      if (!ok) {
        if (o.text.indexOf(WORD_S) === -1) o.text = o.text + ' — ' + WORD_S;
        o.disabled = true;
        if (i === sel.selectedIndex) curOut = true;
      } else if (firstIn < 0) firstIn = i;
    }
    if (curOut && firstIn >= 0) { sel.selectedIndex = firstIn; sel.dispatchEvent(new Event('change')); }
  }

  function soldOutButton(btn) {
    if (!btn || btn.classList.contains('glp-so-btn')) return;
    btn.classList.add('glp-so-btn');
    btn.textContent = WORD_S;
    if ('disabled' in btn) btn.disabled = true;
  }

  function apply() {
    if (!ready) return;
    try {
      css();
      /* 1. catalog cards: badge + fade, sold-out moved to the end of each grid */
      var grids = document.querySelectorAll('.grid');
      for (var g = 0; g < grids.length; g++) {
        var cards = grids[g].querySelectorAll(':scope > .card');
        var moved = false;
        for (var c = 0; c < cards.length; c++) {
          var m = (cards[c].getAttribute('onclick') || '').match(/product\/([\w-]+)/);
          if (!m) continue;
          var out = !prodIn(find(m[1]));
          if (out && !cards[c].classList.contains('glp-so')) {
            cards[c].classList.add('glp-so');
            var v = cards[c].querySelector('.cview'); if (v) v.textContent = WORD_S;
            moved = true;
          }
        }
        if (moved) {
          var so = grids[g].querySelectorAll(':scope > .card.glp-so');
          for (var s = 0; s < so.length; s++) grids[g].appendChild(so[s]);
        }
      }
      /* 2. product page */
      var hm = (location.hash.match(/#product\/([\w-]+)/) || [])[1];
      var p = hm && find(hm);
      if (p) {
        var buy = document.querySelector('.pbuy');
        if (!prodIn(p)) {
          var qty = document.querySelector('.qty'); if (qty) qty.style.display = 'none';
          soldOutButton(buy);
          if (buy) buy.textContent = ES ? 'Agotado por ahora' : 'Sold out right now';
        } else if (p.sizes) {
          var sel = document.getElementById('glp-size-select');
          if (sel && !sel.getAttribute('data-glp-so')) {
            sel.setAttribute('data-glp-so', '1');
            markOptions(sel, function (i) { return p.sizes[i] ? sizeIn(p.sizes[i].v) : true; });
          }
        }
      }
      /* 3. bundles */
      var bw = document.getElementById('glp-bundles');
      if (bw) {
        var bgrid = bw.querySelector('div[style*="grid"]');
        var bcards = bgrid ? bgrid.children : [];
        var list = Bn();
        for (var k = 0; k < bcards.length && k < list.length; k++) {
          var b = list[k], card = bcards[k];
          if (card.getAttribute('data-glp-so')) continue;
          card.setAttribute('data-glp-so', '1');
          var bsel = card.querySelector('select');
          var btn = card.querySelector('a');
          if (!bundleIn(b)) {
            card.classList.add('glp-bso');
            if (bsel) bsel.disabled = true;
            soldOutButton(btn);
          } else if (bsel && bySize[b.wc]) {
            markOptions(bsel, function (i) { return b.sizes[i] ? bundleSizeIn(b, b.sizes[i][0]) : true; });
          }
        }
      }
    } catch (e) { /* display only: never break the page */ }
  }

  /* belt and braces: a sold-out click never reaches the cart */
  function guard() {
    var orig = window.orderNow;
    if (typeof orig !== 'function' || orig.__glpSo) return;
    var w = function (slug) {
      var p = find(slug);
      if (ready && p) {
        var sel = document.getElementById('glp-size-select');
        var z = p.sizes && sel ? p.sizes[sel.value | 0] : null;
        if (!prodIn(p) || (z && !sizeIn(z.v))) {
          if (typeof toast === 'function') toast(ES ? 'Agotado por ahora' : 'Sold out right now');
          return;
        }
      }
      return orig.apply(this, arguments);
    };
    w.__glpSo = true;
    window.orderNow = w;
  }

  function get(u) { return fetch(u, { credentials: 'omit' }).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }); }

  Promise.all([
    get(API + Q + 'per_page=100'),
    get(API + Q + 'type=variation' + AMP + 'per_page=100')
  ]).then(function (res) {
    res[0].forEach(function (x) { inP[x.id] = !!x.is_in_stock; });
    res[1].forEach(function (x) {
      inV[x.id] = !!x.is_in_stock;
      var name = String(x.variation || '').replace(/^[^:]*:\s*/, '').trim();
      if (x.parent && name) { (bySize[x.parent] = bySize[x.parent] || {})[name] = !!x.is_in_stock; }
    });
    ready = true;
    guard();
    apply();
    var t = 0;
    new MutationObserver(function () { clearTimeout(t); t = setTimeout(function () { guard(); apply(); }, 60); })
      .observe(document.body, { childList: true, subtree: true });
    window.addEventListener('hashchange', function () { setTimeout(apply, 200); setTimeout(apply, 900); });
  }).catch(function () { /* store unreachable: leave the page exactly as it was */ });
})();
