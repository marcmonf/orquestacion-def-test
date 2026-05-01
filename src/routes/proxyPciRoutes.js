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
const { createOrder3DS } = require('../connectors/paynopain/payNoPainConnector');
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
  const { paymentId }  = req.body || {};

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

    // Crear orden en Paylands con 3DS activo
    const orderResult = await createOrder3DS({
      paymentId:   tx.paymentId,
      merchantId:  tx.merchantId,
      amount:      tx.amount,
      currency:    tx.currency,
      callbackUrl: tx.callbackUrl,
    });

    if (!orderResult.success) {
      logger.error('PROXY_PCI_CHARGE_ORDER_ERROR', {
        component: 'proxyPciRoutes',
        data: { paymentId, merchantId, error: orderResult.error },
      });
      return res.status(502).json({
        success: false,
        message: orderResult.error || 'Error al crear orden en Paylands',
      });
    }

    // Marcar la transacción como pending_3ds mientras el usuario completa 3DS
    tx.status             = 'hosted_pending';
    tx.processorReference = orderResult.orderToken;
    tx.processor          = 'payNoPain';
    tx.updatedAt          = new Date();
    await tx.save();

    logger.info('PROXY_PCI_CHARGE_3DS_INITIATED', {
      component: 'proxyPciRoutes',
      data: {
        paymentId,
        merchantId,
        orderToken:  orderResult.orderToken,
        checkoutUrl: orderResult.checkoutUrl,
      },
    });

    // Devolver la URL del checkout de Paylands al browser.
    // El browser la cargará en un iFrame para que el usuario complete el pago.
    return res.status(200).json({
      success:     true,
      checkoutUrl: orderResult.checkoutUrl,
      paymentId:   tx.paymentId,
      orderToken:  orderResult.orderToken,
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
