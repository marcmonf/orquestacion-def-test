/* public/checkout-result.js — página de resultado del checkout de Monetiser.
 *
 * Qué hace:
 *  1. Enseña el estado del pago que le pasa el servidor (bloque JSON
 *     #monetiser-runtime). Si todavía no es final (el webhook de Paylands aún
 *     no ha llegado), consulta el estado unos segundos hasta que lo sea.
 *  2. Avisa a la web del comercio que embebe el checkout con postMessage:
 *       { source: 'monetiser', type: 'checkout.result',
 *         paymentId, status, result: 'succeeded' | 'failed' | 'pending' }
 *     El comercio debe comprobar event.origin y tratarlo como INFORMATIVO: el
 *     pago se confirma con el webhook o con GET status, nunca con el navegador.
 *  3. Ofrece volver a la tienda (returnUrl del comercio + paymentId + result).
 *     A pantalla completa vuelve sola a los pocos segundos; dentro de un iFrame
 *     solo con el botón (el navegador exige un clic para sacar al comprador del
 *     iFrame).
 *
 * Sin dependencias ni JavaScript en línea: la CSP de la página solo permite
 * scripts de este mismo servidor.
 */
(function () {
  'use strict';

  var POLL_DELAYS_MS = [1000, 1500, 2000, 2500, 3000, 4000, 5000, 5000, 5000, 5000, 5000, 5000, 5000];
  var AUTO_RETURN_SECONDS = 5;

  var TEXTS = {
    pending: {
      title: 'Confirmando tu pago…',
      message: 'No cierres esta ventana. Solo tardará unos segundos.',
    },
    succeeded: {
      title: 'Pago completado',
      message: 'Tu pago se ha realizado correctamente.',
    },
    failed: {
      title: 'Pago no completado',
      message: 'No se ha podido completar el pago. Puedes volver a la tienda e intentarlo de nuevo.',
    },
    waiting: {
      title: 'Esperando la confirmación',
      message: 'Tu banco todavía no ha confirmado el resultado. El comercio te informará. ' +
        'No repitas el pago hasta saberlo.',
    },
    // Enlace no válido, caducado o pago inexistente: neutro a propósito. Puede
    // verlo alguien que SÍ ha pagado (p. ej. si cambió el secreto de firma del
    // servidor entre el cobro y la vuelta).
    invalid: {
      title: 'Resultado no disponible',
      message: 'No hemos podido mostrar el resultado de este pago. Si lo has completado, ' +
        'el comercio te lo confirmará.',
    },
  };

  function $(id) { return document.getElementById(id); }

  function readRuntime() {
    var el = $('monetiser-runtime');
    if (!el) return null;
    try { return JSON.parse(el.textContent || ''); } catch (e) { return null; }
  }

  var rt = readRuntime();
  var framed = (function () { try { return window.self !== window.top; } catch (e) { return true; } })();
  var notified = false;
  var returnTimer = null;

  function isHttpUrl(url) {
    return typeof url === 'string' && /^https?:\/\//i.test(url);
  }

  function setView(kind) {
    var t = TEXTS[kind] || TEXTS.invalid;
    $('title').textContent = t.title;
    $('message').textContent = t.message;
    var icon = $('icon');
    icon.className = 'icon ' + (kind === 'invalid' ? 'waiting' : kind);
    icon.textContent = kind === 'succeeded' ? '✓'
      : kind === 'failed' ? '✕'
      : (kind === 'waiting' || kind === 'invalid') ? '!'
      : '';
    document.title = t.title;
  }

  function applyBranding(b) {
    if (!b) return;
    if (b.brandColor) document.documentElement.style.setProperty('--brand', b.brandColor);
    if (b.merchantName) $('brand-name').textContent = b.merchantName;
    if (b.logoUrl) {
      var logo = $('brand-logo');
      logo.src = b.logoUrl;
      logo.hidden = false;
    }
  }

  function formatAmount(amount, currency) {
    var n = Number(amount);
    if (!amount || !isFinite(n)) return '';
    try {
      return new Intl.NumberFormat('es-ES', { style: 'currency', currency: currency }).format(n);
    } catch (e) {
      return amount + ' ' + (currency || '');
    }
  }

  function showSummary() {
    var amount = formatAmount(rt.amount, rt.currency);
    if (amount) {
      $('amount').textContent = amount;
      $('summary').hidden = false;
    }
    if (rt.merchantReference) {
      $('reference').textContent = rt.merchantReference;
      $('reference-row').hidden = false;
      $('summary').hidden = false;
    }
  }

  // Aviso a la web del comercio (una sola vez, con el resultado final o, si no
  // llega a tiempo, con 'pending').
  //
  // Destino '*' a propósito: solo lo recibe la página que embebe este iFrame
  // (window.parent), el aviso no lleva nada sensible (paymentId, estado y
  // resultado, que además hay que confirmar en el servidor) y así funciona
  // aunque el comercio embeba desde www.tienda.com y su returnUrl sea
  // tienda.com. Quien debe filtrar es el comercio: event.origin === origen de
  // Monetiser. Cuando exista el snippet monetiser.js (que sabe desde qué web
  // se abre el checkout) se podrá fijar el origen exacto.
  function notifyMerchant(status, result) {
    if (notified || !framed) return;
    notified = true;
    try {
      window.parent.postMessage({
        source: 'monetiser',
        type: 'checkout.result',
        paymentId: rt.paymentId,
        status: status,
        result: result,
      }, '*');
    } catch (e) { /* el comercio no está escuchando: no pasa nada */ }
  }

  function goBack(url) {
    if (!isHttpUrl(url)) return;
    if (framed) {
      try { window.top.location.href = url; return; } catch (e) { /* iFrame con sandbox */ }
    }
    window.location.href = url;
  }

  function offerReturn(url, auto) {
    if (!isHttpUrl(url)) return;
    var btn = $('return-btn');
    btn.hidden = false;
    btn.onclick = function () { goBack(url); };
    if (!auto || framed || returnTimer) return;
    var left = AUTO_RETURN_SECONDS;
    var note = $('redirect-note');
    note.hidden = false;
    note.textContent = 'Volviendo a la tienda en ' + left + ' s…';
    returnTimer = setInterval(function () {
      left -= 1;
      if (left <= 0) {
        clearInterval(returnTimer);
        goBack(url);
        return;
      }
      note.textContent = 'Volviendo a la tienda en ' + left + ' s…';
    }, 1000);
  }

  function finish(status, result, returnUrl) {
    setView(result);
    notifyMerchant(status, result);
    offerReturn(returnUrl, true);
  }

  function giveUp(status, returnUrl) {
    setView('waiting');
    notifyMerchant(status, 'pending');
    offerReturn(returnUrl, false);
  }

  function poll(attempt, lastStatus, lastReturnUrl) {
    if (attempt >= POLL_DELAYS_MS.length) {
      giveUp(lastStatus, lastReturnUrl);
      return;
    }
    setTimeout(function () {
      fetch(rt.statusUrl, { cache: 'no-store', credentials: 'omit' })
        .then(function (res) {
          if (res.status === 403 || res.status === 404 || res.status === 410) {
            return { stop: true };
          }
          if (!res.ok) return null; // 429 / 5xx: se reintenta en el siguiente turno
          return res.json();
        })
        .then(function (data) {
          if (data && data.stop) {
            giveUp(lastStatus, lastReturnUrl);
            return;
          }
          if (data && data.success && data.final) {
            finish(data.status, data.result, data.returnUrl);
            return;
          }
          poll(attempt + 1, (data && data.status) || lastStatus, (data && data.returnUrl) || lastReturnUrl);
        })
        .catch(function () {
          poll(attempt + 1, lastStatus, lastReturnUrl);
        });
    }, POLL_DELAYS_MS[attempt]);
  }

  // ── Arranque ───────────────────────────────────────────────────────────────
  if (!rt || !rt.paymentId) {
    setView('invalid');
    return;
  }

  applyBranding(rt.branding);
  showSummary();

  if (rt.result === 'succeeded' || rt.result === 'failed') {
    finish(rt.status, rt.result, rt.returnUrl);
  } else {
    setView('pending');
    poll(0, rt.status, rt.returnUrl);
  }
})();
