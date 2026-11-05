// public/checkout/providers/stripe_elements.js
//
// PROVEEDOR DE CAMPOS "stripe_elements" del checkout de Monetiser (sesión 5 nov
// 2026, F1 Stripe). Sigue el ejemplo oficial de Stripe
// (stripe-samples/accept-a-payment, custom-payment-flow/client/html/card.js):
//   Stripe(publishableKey) → elements() → create('card') → mount →
//   confirmCardPayment(clientSecret, { payment_method: { card, billing_details } })
//
// La tarjeta SOLO existe dentro del campo alojado de Stripe (un iFrame de
// js.stripe.com): ni el DOM de Monetiser ni sus servidores la ven (PCI SAQ A).
// Stripe.js hace el 3DS si el banco lo pide.
//
// Al terminar, el navegador solo avisa (POST /:merchantId/stripe/complete con el
// paymentId). El servidor consulta el pago en Stripe: nunca se fía del navegador.
(function () {
  'use strict';
  var registry = window.MonetiserCheckoutProviders = window.MonetiserCheckoutProviders || {};

  registry.stripe_elements = {
    formId: 'stripe-form',

    mount: function (core) {
      var RUNTIME = core.runtime;
      var paymentId = RUNTIME.paymentId || '';
      var merchantId = RUNTIME.merchantId || '';
      var cfg = RUNTIME.providerConfig || {};
      var STRIPE_JS_URL = cfg.stripeJsUrl || 'https://js.stripe.com/endive/stripe.js';
      var payBtn = core.payBtn;
      var showStatus = core.showStatus;
      var setLoading = core.setLoading;
      var cardBox = document.getElementById('stripe-card-element');

      var stripe = null;
      var card = null;
      var clientSecret = null;
      var busy = false;

      function post(path, body) {
        return fetch('/' + encodeURIComponent(merchantId) + '/stripe/' + path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }).then(function (r) { return r.json().then(function (j) { j.__status = r.status; return j; }); });
      }

      function goResult(data, fallbackMsg) {
        if (data && typeof data.resultUrl === 'string' && data.resultUrl.indexOf('/checkout/result/') === 0) {
          core.navigate(data.resultUrl);
          return true;
        }
        showStatus('error', (data && data.message) || fallbackMsg);
        setLoading(false);
        busy = false;
        return false;
      }

      function init() {
        post('session', { paymentId: paymentId }).then(function (data) {
          if (!data || !data.success || !data.publishableKey || !data.clientSecret || typeof window.Stripe !== 'function') {
            showStatus('error', (data && data.message) || 'Error al inicializar el pago seguro. Recarga la página.');
            return;
          }
          clientSecret = data.clientSecret;
          stripe = window.Stripe(data.publishableKey);
          var elements = stripe.elements();
          card = elements.create('card', {
            hidePostalCode: true,
            style: { base: { fontSize: '15px', color: '#111', '::placeholder': { color: '#aaa' } } },
          });
          card.mount('#stripe-card-element');
          card.on('ready', function () {
            payBtn.disabled = false;
            payBtn.textContent = 'Pagar ahora';
          });
          card.on('change', function (ev) {
            if (ev && ev.error) {
              cardBox.classList.add('error');
              showStatus('error', ev.error.message || 'Revisa los datos de la tarjeta.');
            } else {
              cardBox.classList.remove('error');
              core.statusMsg.className = 'status-message';
            }
          });
        }).catch(function () {
          showStatus('error', 'Error al inicializar el pago seguro. Recarga la página.');
        });
      }

      var script = document.createElement('script');
      script.src = STRIPE_JS_URL;
      script.onload = init;
      script.onerror = function () {
        showStatus('error', 'Error al cargar el módulo de seguridad. Recarga la página.');
      };
      document.head.appendChild(script);

      payBtn.addEventListener('click', function () {
        if (!core.isActive('card')) return;
        if (!stripe || !card || !clientSecret || busy) return;
        var holder = document.getElementById('stripe-card-holder').value.trim();
        if (!holder) {
          showStatus('error', 'Completa todos los campos.');
          return;
        }
        busy = true;
        setLoading(true);
        core.statusMsg.className = 'status-message';
        stripe.confirmCardPayment(clientSecret, {
          payment_method: { card: card, billing_details: { name: holder } },
        }).then(function (result) {
          if (result && result.error && result.error.type === 'validation_error') {
            // Error de formato detectado por Stripe.js: no llegó a cobrarse nada.
            cardBox.classList.add('error');
            showStatus('error', result.error.message || 'Revisa los datos de la tarjeta.');
            setLoading(false);
            busy = false;
            return;
          }
          // Aprobado, rechazado o 3DS fallido: el servidor consulta Stripe y
          // decide; el comprador va a la página de resultado.
          return post('complete', { paymentId: paymentId }).then(function (data) {
            if (data && data.retry) {
              showStatus('error', data.message || 'Pago no completado.');
              setLoading(false);
              busy = false;
              return;
            }
            goResult(data, 'No se pudo completar el pago.');
          });
        }).catch(function () {
          showStatus('error', 'Error al procesar el pago. Inténtalo de nuevo.');
          setLoading(false);
          busy = false;
        });
      });
    },
  };
})();
