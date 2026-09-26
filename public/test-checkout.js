/* public/test-checkout.js — página de pruebas que simula la web de un comercio.
 *
 * Carga la redirectUrl de un Hosted Checkout en un iFrame y enseña el aviso
 * (postMessage) que la página de resultado de Monetiser manda a la web que la
 * embebe al terminar el pago. Así es como lo recibiría un comercio real:
 *
 *   window.addEventListener('message', function (event) {
 *     if (event.origin !== 'https://orquestacion-def-test.onrender.com') return;
 *     var m = event.data;
 *     if (!m || m.source !== 'monetiser' || m.type !== 'checkout.result') return;
 *     // m.result: 'succeeded' | 'failed' | 'pending' — INFORMATIVO: el pedido
 *     // se da por pagado con el webhook o con GET status, nunca con esto.
 *   });
 */
(function () {
  'use strict';

  var input = document.getElementById('url-input');
  var frame = document.getElementById('checkout-frame');
  var events = document.getElementById('events');

  function loadIframe() {
    var url = input.value.trim();
    if (!/^https?:\/\//i.test(url) && url.charAt(0) !== '/') return;
    frame.src = url;
  }

  document.getElementById('load-btn').addEventListener('click', loadIframe);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') loadIframe();
  });

  window.addEventListener('message', function (event) {
    // Esta página vive en el mismo servidor que el checkout: su origen es el de Monetiser.
    if (event.origin !== window.location.origin) return;
    var m = event.data;
    if (!m || m.source !== 'monetiser' || m.type !== 'checkout.result') return;
    events.textContent = 'Aviso del checkout a la web del comercio:\n' + JSON.stringify(m, null, 2);
  });
})();
