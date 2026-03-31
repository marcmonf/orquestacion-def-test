// src/routes/proxyPciRoutes.js
'use strict';

/**
 * Rutas del flujo Proxy PCI (iFrame de Monetiser con Hosted Fields de Paylands).
 *
 * POST /:merchantId/proxy-pci/session
 *   → Emite un token de sesión del Proxy PCI para la librería ProxyFields.
 *   → El iFrame lo usará para inicializar el sub-iFrame de Paylands.
 *   → Requiere auth (x-api-key) + que la transacción exista en estado válido.
 *
 * POST /:merchantId/proxy-pci/charge
 *   → El browser llama este endpoint tras el submit exitoso de ProxyFields.
 *   → Monetiser recupera el token PCI, ejecuta el cobro S2S contra Paylands.
 *   → Actualiza la Transaction en MongoDB.
 *   → Dispara webhook saliente al merchant si hay callbackUrl.
 *
 * DISEÑO MULTI-CONECTOR:
 *   En el futuro, cuando añadamos Nassau u otro adquirente, este router
 *   consultará el Rule Engine para decidir qué conector usar, y cada conector
 *   tendrá su propio adaptador de tokenización. La interfaz del iFrame no cambia.
 */

const express    = require('express');
const router     = express.Router({ mergeParams: true });
const auth       = require('../middleware/auth');
const rateLimiter = require('../middleware/rateLimiterPayments');
const Transaction = require('../models/Transaction');
const pciProxy   = require('../services/pciProxyService');
const { chargeWithToken } = require('../connectors/paynopain/payNoPainConnector');
const dispatcher = require('../services/webhookDispatcher');
const logger     = require('../utils/logger');

const ALLOWED_STATUSES = ['initialized', 'hosted_pending'];

// ─────────────────────────────────────────────────────────────────────────────
// POST /:merchantId/proxy-pci/session
//
// Emite el token de sesión de tokenización para la librería ProxyFields.
// El iFrame de Monetiser llama este endpoint al cargarse, para obtener el
// token que necesita para inicializar el sub-iFrame de Paylands.
//
// Body: { paymentId }
// Response: { sessionToken, paymentId }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/session', rateLimiter, auth, async (req, res) => {
  const { merchantId } = req.params;
  const { paymentId } = req.body || {};

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

    // Emitir token de sesión del Proxy PCI usando el paymentId como reference
    const sessionToken = await pciProxy.issueTokenizationToken(paymentId);

    logger.info('PROXY_PCI_SESSION_ISSUED', {
      component: 'proxyPciRoutes',
      data: { merchantId, paymentId },
    });

    return res.status(200).json({
      success: true,
      sessionToken,
      paymentId,
    });
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
// El browser llama este endpoint tras el submit exitoso de ProxyFields.
// ProxyFields ha enviado el PAN directamente a Paylands; aquí recuperamos
// el token y ejecutamos el cobro S2S.
//
// Body: { paymentId, expiryMonth, expiryYear, cardHolder }
// Response: { success, paymentId, status }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/charge', rateLimiter, auth, async (req, res) => {
  const { merchantId } = req.params;
  const { paymentId, expiryMonth, expiryYear, cardHolder } = req.body || {};

  if (!paymentId) {
    return res.status(400).json({ success: false, message: 'paymentId es obligatorio' });
  }

  try {
    // Cargar la transacción (lean: false para poder hacer .save())
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

    // Marcar como procesando (evitar doble submit)
    tx.status = 'processing';
    await tx.save();

    // Recuperar el token PCI que Paylands guardó tras el submit del browser
    const tokenData = await pciProxy.getTokenizationResults(paymentId);

    // tokenData: { token, pan, expiryMonth, expiryYear, cardHolder, brand, bank, country }
    const cardToken = tokenData.token;

    // Enriquecer la transacción con datos de BIN/tarjeta del Proxy PCI
    tx.bin          = tokenData.pan ? String(tokenData.pan).replace(/\*/g, '').substring(0, 8) : tx.bin;
    tx.cardBrand    = tokenData.brand  || tx.cardBrand;
    tx.issuerName   = tokenData.bank   || tx.issuerName;
    tx.issuerCountry = tokenData.country ? String(tokenData.country) : tx.issuerCountry;
    tx.expiryMonth  = expiryMonth || tokenData.expiryMonth || tx.expiryMonth;
    tx.expiryYear   = expiryYear  || tokenData.expiryYear  || tx.expiryYear;
    tx.cardholderName = cardHolder || tokenData.cardHolder || tx.cardholderName;

    // Ejecutar el cobro S2S usando el token PCI
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

    // Actualizar estado final
    tx.status             = chargeResult.success ? 'approved' : 'declined';
    tx.processorReference = chargeResult.orderUuid || tx.processorReference;
    tx.processor          = 'payNoPain';
    tx.updatedAt          = new Date();
    await tx.save();

    logger.info('PROXY_PCI_CHARGE_RESULT', {
      component: 'proxyPciRoutes',
      data: {
        paymentId,
        merchantId,
        success: chargeResult.success,
        status: tx.status,
      },
    });

    // Disparar webhook saliente al merchant si tiene callbackUrl
    if (tx.callbackUrl) {
      dispatcher.dispatch({
        url:     tx.callbackUrl,
        event:   'payment.updated',
        payload: {
          paymentId:   tx.paymentId,
          merchantId:  tx.merchantId,
          status:      tx.status,
          amount:      tx.amount,
          currency:    tx.currency,
          processor:   'payNoPain',
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

    // Intentar revertir el estado a 'error' si la transacción existe
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
