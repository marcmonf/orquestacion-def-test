/*! monetiser.js v1 — embebe el checkout de Monetiser en tu web.
 *
 *   <div id="checkout"></div>
 *   <script src="https://orquestacion-def-test.onrender.com/v1/monetiser.js"></script>
 *   <script>
 *     Monetiser.mount('#checkout', {
 *       url: SESSION_URL,                 // la `url` de POST /v1/checkout-sessions
 *       onResult: function (r) {          // r.result: 'succeeded' | 'failed' | 'pending'
 *         // Informativo: confirma el pago en TU servidor (webhook o GET /v1/payments/:id).
 *       }
 *     });
 *   </script>
 *
 * El comprador escribe la tarjeta en los campos de Paylands dentro del iFrame:
 * ni tu web ni Monetiser ven nunca los datos de la tarjeta (PCI DSS SAQ A).
 * Sin dependencias. No llama a la API: la sesión se crea en tu servidor.
 */
(function (window, document) {
  'use strict';

  // Origen de Monetiser = el del propio script. Solo se aceptan avisos (y URLs
  // de checkout) de ese origen.
  var ORIGIN = (function () {
    var s = document.currentScript;
    try { return new URL(s && s.src ? s.src : '', window.location.href).origin; } catch (e) { return ''; }
  })();

  function fail(msg) { throw new Error('Monetiser: ' + msg); }

  function mount(target, options) {
    options = options || {};
    var el = typeof target === 'string' ? document.querySelector(target) : target;
    if (!el) fail('no encuentro el contenedor ' + target);

    var url;
    try { url = new URL(String(options.url || ''), window.location.href); } catch (e) { fail('url no válida'); }
    if (!/^https?:$/.test(url.protocol)) fail('url no válida');
    if (ORIGIN && url.origin !== ORIGIN) fail('la url del checkout no es de ' + ORIGIN);

    var iframe = document.createElement('iframe');
    iframe.src = url.toString();
    iframe.title = options.title || 'Pago seguro';
    iframe.setAttribute('allow', 'payment *');
    iframe.style.width = '100%';
    iframe.style.border = '0';
    iframe.style.display = 'block';
    iframe.style.minHeight = (Number(options.height) || 640) + 'px';

    el.innerHTML = '';
    el.appendChild(iframe);

    var done = false;
    function onMessage(event) {
      if (event.origin !== ORIGIN || event.source !== iframe.contentWindow) return;
      var m = event.data;
      if (!m || m.source !== 'monetiser' || m.type !== 'checkout.result') return;
      if (done && m.result === 'pending') return;
      done = m.result !== 'pending';
      if (typeof options.onResult === 'function') {
        options.onResult({ paymentId: m.paymentId, status: m.status, result: m.result });
      }
    }
    window.addEventListener('message', onMessage);

    return {
      iframe: iframe,
      destroy: function () {
        window.removeEventListener('message', onMessage);
        if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
      },
    };
  }

  window.Monetiser = { version: '1', origin: ORIGIN, mount: mount };
})(window, document);
