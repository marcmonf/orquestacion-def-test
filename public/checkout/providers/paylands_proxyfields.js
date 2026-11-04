// public/checkout/providers/paylands_proxyfields.js
//
// PROVEEDOR DE CAMPOS "paylands_proxyfields" del checkout de Monetiser
// (framework multi-PSP, nov 2026). Es el código de ProxyFields que vivía en
// public/iframe.html, movido SIN cambios de comportamiento: mismas llamadas, en
// el mismo orden, a /:merchantId/proxy-pci/session y /charge, y la misma
// navegación al 3DS de Paylands o a la página de resultado.
//
// Los campos de PAN y CVV son sub-iFrames de Paylands: el PAN nunca pasa por el
// DOM ni por los servidores de Monetiser (PCI SAQ A). El antiguo "modo legacy"
// (?mode=...) pintaba un formulario PROPIO con PAN y CVV — retirado el 26 sep
// 2026 (DEV-LOG §4).
//
// Contrato con el núcleo del checkout (iframe.html): se registra en
// window.MonetiserCheckoutProviders['paylands_proxyfields'] con mount(core).
(function () {
  'use strict';
  var registry = window.MonetiserCheckoutProviders = window.MonetiserCheckoutProviders || {};

  registry.paylands_proxyfields = {
    // Bloque de la página con los campos de este proveedor.
    formId: 'proxy-pci-form',

    mount: function (core) {
      var RUNTIME    = core.runtime;
      var paymentId  = RUNTIME.paymentId  || '';
      var merchantId = RUNTIME.merchantId || '';
      var SERVER_BASE = '';
      // URL de la librería ProxyFields de Paylands. La decide el SERVIDOR según
      // PAYNOPAIN_ENV (sandbox/production).
      var PCI_CLIENT_URL = RUNTIME.pciClientUrl || 'https://pci-proxy-api.paynopain.com/sandbox/client.js';
      var payBtn    = core.payBtn;
      var statusMsg = core.statusMsg;
      var showStatus = core.showStatus;
      var setLoading = core.setLoading;

      var proxyFields  = null;
      var sessionToken = null;

      var script = document.createElement('script');
      script.src   = PCI_CLIENT_URL;
      script.onerror = function () {
        showStatus('error', 'Error al cargar el módulo de seguridad. Recarga la página.');
      };
      script.onload = function () { initProxyPCI(); };
      document.head.appendChild(script);

      async function initProxyPCI() {
        try {
          const sessionRes = await fetch(`${SERVER_BASE}/${merchantId}/proxy-pci/session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ paymentId }),
          });

          if (!sessionRes.ok) {
            throw new Error(`Error al obtener sesión PCI (${sessionRes.status})`);
          }

          const sessionData = await sessionRes.json();
          sessionToken = sessionData.sessionToken;

          proxyFields = new ProxyFields();
          proxyFields.init(sessionToken, {
            cardNumber: 'pan-container',
            cvv:        'cvv-container'
          });

          const fieldStyle = 'width: 100%; height: 44px; border: none; outline: none; font-size: 15px; color: #111; background: transparent; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 0 14px;';

          proxyFields.on('ready', () => {
            proxyFields.setStyle('cardNumber', fieldStyle);
            proxyFields.setStyle('cardNumber::placeholder', 'color: #aaa');
            proxyFields.setPlaceholder('cardNumber', '4111 1111 1111 1111');
            proxyFields.setStyle('cvv', fieldStyle);
            proxyFields.setStyle('cvv::placeholder', 'color: #aaa');
            proxyFields.setPlaceholder('cvv', '123');
            document.getElementById('pan-container').classList.add('ready');
            document.getElementById('cvv-container').classList.add('ready');
            payBtn.disabled    = false;
            payBtn.textContent = 'Pagar ahora';
          });

          proxyFields.on('validate', (data) => {
            if (data && data.hasErrors) {
              if (data.fields?.cardNumber) document.getElementById('pan-container').classList.add('error');
              if (data.fields?.cvv)        document.getElementById('cvv-container').classList.add('error');
              showStatus('error', 'Revisa los datos de la tarjeta.');
            } else {
              document.getElementById('pan-container').classList.remove('error');
              document.getElementById('cvv-container').classList.remove('error');
              statusMsg.className = 'status-message';
            }
          });

          proxyFields.on('success', async () => {
            try {
              const chargeRes = await fetch(`${SERVER_BASE}/${merchantId}/proxy-pci/charge`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                // Solo el paymentId (y, si el titular marcó la casilla, su
                // consentimiento para guardar la tarjeta). Nunca datos de tarjeta.
                body: JSON.stringify(core.saveCardConsent && core.saveCardConsent() ? { paymentId, saveCard: true } : { paymentId }),
              });
              const chargeData = await chargeRes.json();

              if (chargeData.success && chargeData.requires3DS && chargeData.threeDsUrl) {
                // Banco requiere 3DS — cargar el challenge en este mismo iframe.
                // Al terminar, Paylands trae al comprador a la página de
                // resultado (url_ok / url_ko).
                core.navigate(chargeData.threeDsUrl);
              } else if (typeof chargeData.resultUrl === 'string' && chargeData.resultUrl.startsWith('/checkout/result/')) {
                // Resultado sin 3DS (o pago ya cerrado por un error): la misma
                // página de resultado que tras el 3DS.
                core.navigate(chargeData.resultUrl);
              } else {
                // Error ANTES de cobrar: el pago sigue abierto y se puede reintentar.
                showStatus('error', chargeData.message || 'No se pudo iniciar el pago.');
                setLoading(false);
              }
            } catch (chargeErr) {
              showStatus('error', 'Error al procesar el pago. Inténtalo de nuevo.');
              setLoading(false);
            }
          });

          proxyFields.on('error', () => {
            showStatus('error', 'Error al procesar la tarjeta.');
            setLoading(false);
          });

        } catch (initErr) {
          showStatus('error', 'Error al inicializar el pago seguro. Recarga la página.');
          console.error('[Monetiser] initProxyPCI error:', initErr);
        }
      }

      payBtn.addEventListener('click', function () {
        if (!core.isActive('card')) return;
        if (!proxyFields) return;
        const expiryMonth = document.getElementById('expiry-month').value.trim();
        const expiryYear  = document.getElementById('expiry-year').value.trim();
        const cardHolder  = document.getElementById('card-holder').value.trim();

        if (!expiryMonth || !expiryYear || !cardHolder) {
          showStatus('error', 'Completa todos los campos.');
          return;
        }

        setLoading(true);
        statusMsg.className = 'status-message';

        proxyFields.submit({
          expiryMonth,
          expiryYear: expiryYear.length === 2 ? '20' + expiryYear : expiryYear,
          cardHolder,
        });
      });
    },
  };
})();
