// public/demo/app.js — tienda de demostración "Alfar Brisa" (inventada).
// El navegador solo manda SKUs y cantidades a /demo/api; el servidor calcula el
// importe y crea el pago con la clave de pruebas de la tienda (nunca llega aquí).
(function () {
  'use strict';
  var products = [];
  var cart = {};
  var $ = function (id) { return document.getElementById(id); };
  var eur = function (c) { return (c / 100).toFixed(2).replace('.', ',') + ' €'; };

  function api(path, body) {
    return fetch('/demo/api/' + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.message || ('HTTP ' + r.status)); return j; }); });
  }
  function msg(text, isError) { var m = $('msg'); m.textContent = text || ''; m.className = 'msg' + (isError ? ' error' : ''); }
  function items() { return Object.keys(cart).filter(function (k) { return cart[k] > 0; }).map(function (k) { return { sku: k, qty: cart[k] }; }); }

  function art(color) {
    return '<svg viewBox="0 0 120 90" width="120" height="90" aria-hidden="true"><ellipse cx="60" cy="78" rx="38" ry="6" fill="#00000012"/>' +
      '<path d="M28 22h64l-6 50a8 8 0 0 1-8 7H42a8 8 0 0 1-8-7z" fill="' + color + '"/><ellipse cx="60" cy="22" rx="32" ry="6" fill="#ffffff55"/></svg>';
  }

  function renderCatalog() {
    $('catalog').innerHTML = '';
    products.forEach(function (p) {
      var el = document.createElement('div');
      el.className = 'product';
      el.innerHTML = '<div class="art" style="background:' + p.color + '22">' + art(p.color) + '</div>' +
        '<div class="body"><div class="name"></div><div class="desc"></div><div class="row"><span class="price"></span><button class="btn small">Añadir</button></div></div>';
      el.querySelector('.name').textContent = p.name;
      el.querySelector('.desc').textContent = p.description;
      el.querySelector('.price').textContent = eur(p.price);
      el.querySelector('button').addEventListener('click', function () { cart[p.sku] = Math.min((cart[p.sku] || 0) + 1, 10); renderCart(); });
      $('catalog').appendChild(el);
    });
  }

  function renderCart() {
    var lines = items();
    var total = 0;
    $('cartLines').innerHTML = lines.length ? '' : '<p class="muted">El carrito está vacío.</p>';
    lines.forEach(function (l) {
      var p = products.filter(function (x) { return x.sku === l.sku; })[0];
      total += p.price * l.qty;
      var row = document.createElement('div');
      row.className = 'cart-line';
      row.innerHTML = '<span class="n"></span><span class="qty"><button aria-label="Quitar uno">−</button><b></b><button aria-label="Añadir uno">+</button></span><span class="s"></span>';
      row.querySelector('.n').textContent = p.name;
      row.querySelector('b').textContent = l.qty;
      row.querySelector('.s').textContent = eur(p.price * l.qty);
      var bs = row.querySelectorAll('button');
      bs[0].addEventListener('click', function () { cart[l.sku] = l.qty - 1; renderCart(); });
      bs[1].addEventListener('click', function () { cart[l.sku] = Math.min(l.qty + 1, 10); renderCart(); });
      $('cartLines').appendChild(row);
    });
    $('cartTotal').textContent = eur(total);
    $('cartCount').textContent = lines.reduce(function (a, l) { return a + l.qty; }, 0);
    $('payBtn').disabled = $('linkBtn').disabled = !lines.length;
  }

  function showOrder(paymentId) {
    api('order/' + encodeURIComponent(paymentId)).then(function (o) {
      $('orderInfo').textContent = 'Pedido ' + (o.reference || '') + ' · estado ' + o.status + (o.connector ? ' · adquirente ' + o.connector : '') + (o.routingReason ? ' (' + o.routingReason + ')' : '');
    }).catch(function () {});
  }

  $('payBtn').addEventListener('click', function () {
    msg('Preparando el pago…');
    $('payBtn').disabled = true;
    api('checkout', { items: items(), country: $('country').value }).then(function (s) {
      msg('');
      $('checkoutPanel').hidden = false;
      $('linkPanel').hidden = true;
      $('checkout').innerHTML = '';
      showOrder(s.paymentId);
      window.Monetiser.mount('#checkout', {
        url: s.url,
        onResult: function (r) {
          showOrder(s.paymentId);
          if (r && r.result === 'succeeded') { cart = {}; renderCart(); }
        },
      });
      $('checkoutPanel').scrollIntoView({ behavior: 'smooth' });
    }).catch(function (e) { msg(e.message, true); }).then(function () { $('payBtn').disabled = !items().length; });
  });

  $('linkBtn').addEventListener('click', function () {
    msg('Creando enlace…');
    api('payment-link', { items: items() }).then(function (l) {
      msg('');
      $('linkPanel').hidden = false;
      $('checkoutPanel').hidden = true;
      $('linkUrl').href = l.url;
      $('linkUrl').textContent = l.url;
      $('linkQr').src = l.qrUrl;
      $('linkPanel').scrollIntoView({ behavior: 'smooth' });
    }).catch(function (e) { msg(e.message, true); });
  });
  $('closeCheckout').addEventListener('click', function () { $('checkoutPanel').hidden = true; $('checkout').innerHTML = ''; });
  $('closeLink').addEventListener('click', function () { $('linkPanel').hidden = true; });

  api('catalog').then(function (c) {
    products = c.products;
    c.countries.forEach(function (cc) { var o = document.createElement('option'); o.value = cc; o.textContent = cc; $('country').appendChild(o); });
    renderCatalog(); renderCart();
  }).catch(function (e) { msg('No se pudo cargar el catálogo: ' + e.message, true); });

  var params = new URLSearchParams(location.search);
  if (params.get('pedido')) msg('Has vuelto del pago del pedido ' + params.get('pedido') + '.');
})();
