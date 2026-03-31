// src/routes/proxyPciRoutes.js
'use strict';

/**
 * Rutas del flujo Proxy PCI (iFrame de Monetiser con Hosted Fields de Paylands).
 *
 * POST /:merchantId/proxy-pci/session
 *   → Emite un token de sesión del Proxy PCI para la librería ProxyFields.
 *   → NO requiere x-api-key: el iFrame corre en el browser del usuario final,
 *     no en el servidor del merchant. La protección real es que el paymentId
 *     debe existir en MongoDB y estar en estado válido (initialized/hosted_pending).
 *
 * POST /:merchantId/proxy-pci/charge
 *   → El browser llama este endpoint tras el submit exitoso de ProxyFields.
 *   → Monetiser recupera el token PCI, ejecuta el cobro S2S contra Paylands.
 *   → Misma protección: paymentId válido en MongoDB.
 *
 * DISEÑO MULTI-CONECTOR:
 *   Cuando añadamos Nassau u otro adquirente, este router consultará el Rule
 *   Engine para decidir qué conector usar. La interfaz del iFrame no cambia.
 */

const express     = require('express');
const router      = express.Router({ mergeParams: true });
const rateLimiter = require('../middleware/rateLimiterPayments');
const Transaction = require('../models/Transaction');
const pciProxy    = require('../services/pciProxyService');
const { chargeWithToken } = require('../connectors/paynopain/payNoPainConnector');
const dispatcher  = require('../services/webhookDispatcher');
const logger      = require('../utils/logger');

const ALLOWED_STATUSES = ['initialized', 'hosted_pending'];

// ─────────────────────────────────────────────────────────────────────────────
// POST /:merchantId/proxy-pci/session
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

    // Marcar como procesando para evitar doble submit
    tx.status = 'processing';
    await tx.save();

    // Recuperar el token PCI que Paylands guardó tras el submit del browser
    const tokenData = await pciProxy.getTokenizationResults(paymentId);
    const cardToken = tokenData.token;

    // Enriquecer la transacción con datos del Proxy PCI
    tx.bin           = tokenData.pan ? String(tokenData.pan).replace(/\*/g, '').substring(0, 8) : tx.bin;
    tx.cardBrand     = tokenData.brand   || tx.cardBrand;
    tx.issuerName    = tokenData.bank    || tx.issuerName;
    tx.issuerCountry = tokenData.country ? String(tokenData.country) : tx.issuerCountry;
    tx.expiryMonth   = expiryMonth || tokenData.expiryMonth || tx.expiryMonth;
    tx.expiryYear    = expiryYear  || tokenData.expiryYear  || tx.expiryYear;
    tx.cardholderName = cardHolder || tokenData.cardHolder  || tx.cardholderName;

    // Ejecutar cobro S2S con el token PCI
    const chargeResult = await chargeWithToken({
      paymentId:   tx.paymentId,
      merchantId:  tx.merchantId,
      amount:      tx.amount,
      currency:    tx.currency,
      cardToken,
      expiryMonth: tx.expiryMonth,
      expiryYear:  tx.expiryYear,
      cardHolder:  tx.cardholderName,
      callbackUrl: tx.callbackUrl,
    });

    tx.status             = chargeResult.success ? 'approved' : 'declined';
    tx.processorReference = chargeResult.orderUuid || tx.processorReference;
    tx.processor          = 'payNoPain';
    tx.updatedAt          = new Date();
    await tx.save();

    logger.info('PROXY_PCI_CHARGE_RESULT', {
      component: 'proxyPciRoutes',
      data: { paymentId, merchantId, success: chargeResult.success, status: tx.status },
    });

    // Webhook saliente al merchant
    if (tx.callbackUrl) {
      dispatcher.dispatch({
        url:     tx.callbackUrl,
        event:   'payment.updated',
        payload: {
          paymentId:          tx.paymentId,
          merchantId:         tx.merchantId,
          status:             tx.status,
          amount:             tx.amount,
          currency:           tx.currency,
          processor:          'payNoPain',
          processorReference: tx.processorReference,
        },
      }).catch(err => {
        logger.warn('PROXY_PCI_WEBHOOK_DISPATCH_ERROR', {
          component: 'proxyPciRoutes',
          data: { paymentId, error: err.message },
        });
      });
    }

    return res.status(200).json({
      success: chargeResult.success,
      paymentId:   tx.paymentId,
      status:      tx.status,
      error:       chargeResult.error || null,
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

    return res.status(500).json({ success: false, message: 'Error al procesar el cobro' });
  }
});

module.exports = router;
