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
 */

const express    = require('express');
const router     = express.Router({ mergeParams: true });
const rateLimiter = require('../middleware/rateLimiterPayments');
const Transaction = require('../models/Transaction');
const pciProxy    = require('../services/pciProxyService');
const { chargeWithToken } = require('../connectors/paynopain/payNoPainConnector');
const logger      = require('../utils/logger');

const ALLOWED_STATUSES = ['initialized', 'hosted_pending'];

// ─────────────────────────────────────────────────────────────────────────────
// POST /:merchantId/proxy-pci/session
// Mantenida para compatibilidad. El iFrame puede seguir llamando este endpoint.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/session', rateLimiter, async (req, res) => {
  const { merchantId } = req.params;
  const { paymentId }  = req.body || {};

  if (!paymentId) {
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

  if (!paymentId) {
    return res.status(400).json({ success: false, message: 'paymentId es obligatorio' });
  }

  try {
    const tx = await Transaction.findOne({ paymentId, merchantId }).lean(false);

    if (!tx) {
      return res.status(404).json({ success: false, message: 'Transacción no encontrada' });
    }

    if (!ALLOWED_STATUSES.includes(tx.status)) {
      return res.status(409).json({
        success: false,
        message: `Transacción en estado no válido: ${tx.status}`,
      });
    }

    // Paso 1: Obtener el token PCI generado por ProxyFields tras el submit del browser
    const tokenResult = await pciProxy.getTokenizationResults(paymentId);

    if (!tokenResult || !tokenResult.token) {
      logger.error('PROXY_PCI_CHARGE_NO_TOKEN', {
        component: 'proxyPciRoutes',
        data: { paymentId, merchantId },
      });
      return res.status(422).json({
        success: false,
        message: 'No se encontró token PCI para esta transacción. El usuario no ha completado el formulario.',
      });
    }

    // Scope PCI SAQ A: aqui no entra ni el PAN ni el token de tarjeta, solo ids.
    // El sanitizador de logger.js es una red de seguridad, no la primera linea.
    logger.info('PROXY_PCI_TOKEN_RETRIEVED', {
      component: 'proxyPciRoutes',
      data: {
        paymentId,
        merchantId,
        cardUuid:    tokenResult.card_uuid || tokenResult.uuid || tokenResult.source_uuid || 'N/A',
      },
    });

    // Paso 2: Cobrar directamente en Paylands con el token PCI
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

    // Paso 3: Determinar status correcto y guardar UNA sola vez
    // Primero verificamos si hay 3DS pendiente para no guardar 'declined' prematuramente
    if (chargeResult.requires3DS && chargeResult.threeDsUrl) {
      tx.status             = 'pending_3ds';
      tx.processorReference = chargeResult.processorReference || null;
      tx.processor          = 'payNoPain';
      tx.updatedAt          = new Date();
      await tx.save();

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

    // Sin 3DS: pago aprobado o rechazado directamente
    tx.status             = chargeResult.success ? 'approved' : 'declined';
    tx.processorReference = chargeResult.processorReference || null;
    tx.processor          = 'payNoPain';
    tx.updatedAt          = new Date();
    await tx.save();

    logger.info('PROXY_PCI_CHARGE_RESULT', {
      component: 'proxyPciRoutes',
      data: { paymentId, merchantId, success: chargeResult.success, status: tx.status },
    });

    if (!chargeResult.success) {
      return res.status(200).json({
        success: false,
        message: chargeResult.error || 'Pago rechazado por el banco.',
        paymentId,
      });
    }

    return res.status(200).json({
      success:   true,
      paymentId: tx.paymentId,
      status:    'approved',
    });

  } catch (err) {
    logger.error('PROXY_PCI_CHARGE_ERROR', {
      component: 'proxyPciRoutes',
      data: { merchantId, paymentId, error: err.message },
    });

    try {
      await Transaction.updateOne(
        { paymentId, merchantId },
        { $set: { status: 'error', updatedAt: new Date() } }
      );
    } catch (_) { /* no-op */ }

    return res.status(500).json({ success: false, message: 'Error al procesar el pago' });
  }
});

module.exports = router;
