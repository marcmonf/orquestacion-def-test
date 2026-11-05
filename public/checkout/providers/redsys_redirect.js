// public/checkout/providers/redsys_redirect.js
//
// PROVEEDOR "redsys_redirect" del checkout de Monetiser (sesión 6 nov 2026).
// Redsys por REDIRECCIÓN: aquí no hay ningún campo de tarjeta (PCI SAQ A). Al
// pulsar "Pagar", el servidor prepara el formulario firmado
// (POST /:merchantId/redsys/start) y el navegador lo envía a la página de pago
// de Redsys en la VENTANA ENTERA (target _top): no está verificado que Redsys
// admita ir dentro de un iFrame. Al terminar, Redsys devuelve al comprador a la
// página de resultado de Monetiser (UrlOK / UrlKO).
(function () {
  'use strict';
  var registry = window.MonetiserCheckoutProviders = window.MonetiserCheckoutProviders || {};

  registry.redsys_redirect = {
    formId: 'redsys-form',

    mount: function (core) {
      var paymentId = core.runtime.paymentId || '';
      var merchantId = core.runtime.merchantId || '';
      var payBtn = core.payBtn;
      var busy = false;
      payBtn.disabled = false;
      payBtn.textContent = 'Pagar ahora';

      payBtn.addEventListener('click', function () {
        if (!core.isActive('card') || busy) return;
        busy = true;
        core.setLoading(true);
        fetch('/' + encodeURIComponent(merchantId) + '/redsys/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paymentId: paymentId }),
        }).then(function (r) { return r.json(); }).then(function (data) {
          var a = data && data.action;
          if (!data || !data.success || !a || typeof a.url !== 'string' || !/^https:\/\/sis(-t)?\.redsys\.es(:\d+)?\//.test(a.url)) {
            core.showStatus('error', (data && data.message) || 'No se pudo iniciar el pago.');
            core.setLoading(false);
            busy = false;
            return;
          }
          var form = document.createElement('form');
          form.method = 'POST';
          form.action = a.url;
          form.target = '_top';
          ['Ds_SignatureVersion', 'Ds_MerchantParameters', 'Ds_Signature'].forEach(function (k) {
            var i = document.createElement('input');
            i.type = 'hidden';
            i.name = k;
            i.value = String(a.fields[k] || '');
            form.appendChild(i);
          });
          document.body.appendChild(form);
          form.submit();
        }).catch(function () {
          core.showStatus('error', 'Error al iniciar el pago. Inténtalo de nuevo.');
          core.setLoading(false);
          busy = false;
        });
      });
    },
  };
})();
