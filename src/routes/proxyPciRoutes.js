// src/routes/proxyPciRoutes.js
'use strict';

/**
 * Rutas del flujo Hosted Checkout con 3DS de Paylands.
 *
 * POST /:merchantId/proxy-pci/session
 *   → (Mantenida por compatibilidad con el iFrame — puede quitarse en la próxima
 *     iteración si el flujo 3DS no necesita ProxyFields para el primer pago)
 *   → Emite un token de sesión del Proxy PCI para la librería ProxyFields.
 *
 * POST /:merchantId/proxy-pci/charge
 *   → El browser llama este endpoint cuando el usuario pulsa "Pagar".
 *   → Monetiser crea una orden en Paylands con secure:true + extra_data (3DS).
 *   → Devuelve checkoutUrl: la URL del checkout de Paylands que se carga en iFrame.
 *   → El usuario completa tarjeta + 3DS en el checkout de Paylands.
 *   → Paylands notifica el resultado por webhook POST /webhooks/paynopain.
 *
 * FLUJO COMPLETO:
 *   Browser → POST /charge → Monetiser crea orden 3DS en Paylands
 *          ← { checkoutUrl }
 *   Browser carga checkoutUrl en iFrame secundario
 *   Usuario introduce tarjeta y autentica con banco (3DS)
 *   Paylands → POST /webhooks/paynopain → Monetiser actualiza MongoDB
 *   Paylands → redirige al comprador a url_ok/url_ko = página de resultado
 *              (/checkout/result/:paymentId, ver routes/checkoutResult.js)
 *
 * Si el cobro termina SIN 3DS (o falla después de llamar a Paylands), la
 * respuesta lleva `resultUrl` y el iFrame navega a esa misma página de
 * resultado: el comprador y la web del comercio se enteran igual en los dos
 * caminos.
 */

const express    = require('express');
const router     = express.Router({ mergeParams: true });
// Límite por IP y por paymentId (endpoints públicos del navegador del comprador).
const rateLimiter = require('../middleware/rateLimiterCheckout');
const Transaction = require('../models/Transaction');
const pciProxy    = require('../services/pciProxyService');
const { chargeWithToken } = require('../connectors/paynopain/payNoPainConnector');
const { resultPath } = require('../utils/checkoutResult');
const logger      = require('../utils/logger');

const ALLOWED_STATUSES = ['initialized', 'hosted_pending'];

// Metadatos NO sensibles de la tarjeta que devuelve el Proxy PCI (el PAN llega
// ENMASCARADO). Se guardan BIN (6), últimos 4, marca, banco y país: permitido
// por PCI DSS (truncado) y necesario para el coste real (interchange por marca/
// tipo/región), las analíticas y, más adelante, el routing por BIN. Antes no se
// guardaba nada y el "Coste real" salía con interchange 0 en todos los pagos.
function cardMetadata(tokenResult) {
  const out = {};
  const masked = String(tokenResult?.pan || tokenResult?.masked_pan || '');
  const digits = masked.replace(/[^0-9*Xx•]/g, '');
  const firstSix = digits.slice(0, 6);
  const lastFour = digits.slice(-4);
  if (/^\d{6}$/.test(firstSix)) out.bin = firstSix;
  if (/^\d{4}$/.test(lastFour) && digits.length >= 10) out.cardLast4 = lastFour;
  if (tokenResult?.brand)   out.cardBrand     = String(tokenResult.brand).toLowerCase().slice(0, 32);
  if (tokenResult?.type)    out.cardType      = String(tokenResult.type).toLowerCase().slice(0, 32);
  if (tokenResult?.bank)    out.issuerName    = String(tokenResult.bank).slice(0, 128);
  if (tokenResult?.country) out.issuerCountry = String(tokenResult.country).toUpperCase().slice(0, 3);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /:merchantId/proxy-pci/session
// Mantenida para compatibilidad. El iFrame puede seguir llamando este endpoint.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/session', rateLimiter, async (req, res) => {
  const { merchantId } = req.params;
  const { paymentId }  = req.body || {};

  if (!paymentId || typeof paymentId !== 'string') {
    return res.status(400).json({ success: false, message: 'paymentId es obligatorio' });
  }

  try {
    const tx = await Transaction.findOne({ paymentId, merchantId }).lean();

    if (!tx) {
      return res.status(404).json({ success: false, message: 'Transacción no encontrada' });
    }

    if (!ALLOWED_STATUSES.includes(tx.status)) {
      return res.status(409).json({
        success: false,
        message: `Transacción en estado no válido: ${tx.status}`,
      });
    }

    const sessionToken = await pciProxy.issueTokenizationToken(paymentId);

    logger.info('PROXY_PCI_SESSION_ISSUED', {
      component: 'proxyPciRoutes',
      data: { merchantId, paymentId },
    });

    return res.status(200).json({ success: true, sessionToken, paymentId });

  } catch (err) {
    logger.error('PROXY_PCI_SESSION_ERROR', {
      component: 'proxyPciRoutes',
      data: { merchantId, paymentId, error: err.message },
    });
    return res.status(500).json({ success: false, message: 'Error al emitir sesión PCI' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /:merchantId/proxy-pci/charge
//
// NUEVO FLUJO (Paylands 3DS Hosted Checkout):
//   1. Verificar que la transacción existe y está en estado válido
//   2. Crear orden en Paylands con secure:true + extra_data
//   3. Devolver checkoutUrl al browser
//   4. Browser carga checkoutUrl → usuario hace 3DS → Paylands notifica por webhook
// ─────────────────────────────────────────────────────────────────────────────
router.post('/charge', rateLimiter, async (req, res) => {
  const { merchantId } = req.params;
  const { paymentId, expiryMonth, expiryYear, cardHolder } = req.body || {};

  if (!paymentId || typeof paymentId !== 'string') {
    return res.status(400).json({ success: false, message: 'paymentId es obligatorio' });
  }

  // ── Paso 0: RESERVA ATÓMICA del cobro (anti doble cobro) ────────────────────
  // Antes se leía el estado, se cobraba en Paylands y se guardaba después. Dos
  // "Pagar" casi simultáneos (doble clic, reintento del navegador) pasaban los
  // dos la comprobación → DOS órdenes en Paylands → doble retención al comprador,
  // y la primera orden quedaba huérfana (su processorReference se pisaba).
  // Ahora solo UNA petición consigue pasar el pago a 'processing'.
  let tx;
  try {
    tx = await Transaction.findOneAndUpdate(
      { paymentId, merchantId, status: { $in: ALLOWED_STATUSES } },
      { $set: { status: 'processing', updatedAt: new Date() } },
      { new: true }
    );
  } catch (err) {
    logger.error('PROXY_PCI_CHARGE_RESERVE_ERROR', {
      component: 'proxyPciRoutes',
      data: { merchantId, paymentId, error: err.message },
    });
    return res.status(500).json({ success: false, message: 'Error al procesar el pago' });
  }

  if (!tx) {
    const existing = await Transaction.findOne({ paymentId, merchantId }).lean().catch(() => null);
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Transacción no encontrada' });
    }
    return res.status(409).json({
      success: false,
      message: `Transacción en estado no válido: ${existing.status}`,
    });
  }

  // Si algo falla ANTES de llegar a Paylands, se devuelve el pago a su estado
  // inicial para que el comprador pueda volver a intentarlo.
  async function releaseReservation() {
    try {
      await Transaction.updateOne(
        { paymentId, merchantId, status: 'processing' },
        { $set: { status: 'hosted_pending', updatedAt: new Date() } }
      );
    } catch (_) { /* no-op */ }
  }

  let chargeStarted = false;
  try {
    // Paso 1: Obtener el token PCI generado por ProxyFields tras el submit del browser
    let tokenResult = null;
    try {
      tokenResult = await pciProxy.getTokenizationResults(paymentId);
    } catch (e) {
      tokenResult = null;
    }

    if (!tokenResult || !tokenResult.token) {
      logger.error('PROXY_PCI_CHARGE_NO_TOKEN', {
        component: 'proxyPciRoutes',
        data: { paymentId, merchantId },
      });
      await releaseReservation();
      return res.status(422).json({
        success: false,
        message: 'No se encontró token PCI para esta transacción. El usuario no ha completado el formulario.',
      });
    }

    // Scope PCI SAQ A: aquí no entra ni el PAN ni el token de tarjeta, solo ids.
    // (El token de tarjeta es cobrable: no se registra en logs.)
    logger.info('PROXY_PCI_TOKEN_RETRIEVED', {
      component: 'proxyPciRoutes',
      data: { paymentId, merchantId, brand: tokenResult.brand || null },
    });

    // Paso 2: Cobrar directamente en Paylands con el token PCI
    chargeStarted = true;
    const chargeResult = await chargeWithToken({
      paymentId:   tx.paymentId,
      merchantId:  tx.merchantId,
      amount:      tx.amount,
      currency:    tx.currency,
      cardToken:   tokenResult.token,
      expiryMonth: expiryMonth || tokenResult.expiryMonth,
      expiryYear:  expiryYear  || tokenResult.expiryYear,
      cardHolder:  cardHolder  || tokenResult.holder || 'Cardholder',
    });

    const meta = cardMetadata(tokenResult);

    // Paso 3: Determinar status correcto y guardar UNA sola vez
    // Primero verificamos si hay 3DS pendiente para no guardar 'declined' prematuramente
    if (chargeResult.requires3DS && chargeResult.threeDsUrl) {
      await Transaction.updateOne(
        { paymentId, merchantId, status: 'processing' },
        { $set: {
          status:             'pending_3ds',
          processorReference: chargeResult.processorReference || null,
          processor:          'payNoPain',
          updatedAt:          new Date(),
          ...meta,
        } }
      );

      logger.info('PROXY_PCI_CHARGE_RESULT', {
        component: 'proxyPciRoutes',
        data: { paymentId, merchantId, success: true, status: 'pending_3ds' },
      });

      return res.status(200).json({
        success:     true,
        requires3DS: true,
        threeDsUrl:  chargeResult.threeDsUrl,
        paymentId,
      });
    }

    // Sin 3DS: pago aprobado, rechazado o error técnico. Antes cualquier fallo
    // (credenciales mal puestas, Paylands caído, 4xx de validación) se guardaba
    // como 'declined' y al comprador se le decía "rechazado por el banco": las
    // analíticas contaban errores propios como rechazos del banco. El conector
    // marca los fallos técnicos con `error`.
    const finalStatus = chargeResult.success
      ? 'authorized'
      : (chargeResult.error ? 'error' : 'declined');
    await Transaction.updateOne(
      { paymentId, merchantId, status: 'processing' },
      { $set: {
        status:             finalStatus,
        processorReference: chargeResult.processorReference || null,
        processor:          'payNoPain',
        updatedAt:          new Date(),
        ...meta,
      } }
    );

    logger.info('PROXY_PCI_CHARGE_RESULT', {
      component: 'proxyPciRoutes',
      data: { paymentId, merchantId, success: chargeResult.success, status: finalStatus },
    });

    if (!chargeResult.success) {
      return res.status(200).json({
        success: false,
        message: finalStatus === 'error'
          ? 'No se ha podido procesar el pago.'
          : 'Pago rechazado por el banco.',
        paymentId,
        status:    finalStatus,
        resultUrl: resultPath(paymentId, 'ko'),
      });
    }

    return res.status(200).json({
      success:   true,
      paymentId: tx.paymentId,
      status:    finalStatus,
      resultUrl: resultPath(tx.paymentId, 'ok'),
    });

  } catch (err) {
    logger.error('PROXY_PCI_CHARGE_ERROR', {
      component: 'proxyPciRoutes',
      data: { merchantId, paymentId, error: err.message },
    });

    if (!chargeStarted) {
      await releaseReservation();
      // El pago vuelve a su estado inicial: el comprador puede reintentarlo.
      return res.status(500).json({ success: false, message: 'Error al procesar el pago' });
    }

    // La llamada a Paylands pudo llegar a crear la orden: estado 'error'. Si
    // Paylands notifica después el resultado, el webhook lo corrige (ver
    // utils/paymentStatus: 'error' admite pasar a authorized/declined).
    try {
      await Transaction.updateOne(
        { paymentId, merchantId, status: 'processing' },
        { $set: { status: 'error', updatedAt: new Date() } }
      );
    } catch (_) { /* no-op */ }

    // Ya no se puede reintentar este pago: se lleva al comprador a la página de
    // resultado en vez de decirle "inténtalo de nuevo" sobre un pago cerrado.
    return res.status(500).json({
      success:   false,
      message:   'Error al procesar el pago',
      resultUrl: resultPath(paymentId, 'ko'),
    });
  }
});

module.exports = router;
module.exports._test = { cardMetadata };
