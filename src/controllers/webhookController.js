// src/controllers/webhookController.js
'use strict';

const Transaction  = require('../models/Transaction');
const logger       = require('../utils/logger');
const { validateNotificationHash, SIGNATURE } = require('../connectors/paynopain/payNoPainConnector');

/**
 * Recibe la notificación de Paylands cuando un pago finaliza.
 *
 * Paylands hace POST a /webhooks/paynopain con el objeto order completo.
 * Nosotros:
 *   1. Validamos el hash para verificar que viene de Paylands
 *   2. Buscamos la transacción por el campo "additional" (donde guardamos paymentId)
 *   3. Actualizamos el status en MongoDB
 *   4. Respondemos 200 para que Paylands sepa que recibimos la notificación
 */
async function handlePayNoPainWebhook(req, res) {
  const notification = req.body;

  // Validar que la notificación viene de Paylands
  const isValid = validateNotificationHash(notification, SIGNATURE);
  if (!isValid) {
    logger.warn('webhookController: hash inválido', {
      component: 'webhook',
      event: 'PAYNOPAIN_WEBHOOK_INVALID_HASH',
      data: { received: notification?.validation_hash }
    });
    return res.status(401).json({ success: false, error: 'invalid_hash' });
  }

  const order = notification.order;
  if (!order) {
    return res.status(400).json({ success: false, error: 'missing_order' });
  }

  // El paymentId lo guardamos en el campo "additional" al crear la orden
  const paymentId = order.additional;
  const orderStatus = order.status; // SUCCESS, REFUSED, EXPIRED, etc.

  logger.info('webhookController: notificación recibida', {
    component: 'webhook',
    event: 'PAYNOPAIN_WEBHOOK_RECEIVED',
    data: { paymentId, orderStatus, orderUuid: order.uuid }
  });

  // Mapear estado de Paylands al estado interno de Monetiser
  const statusMap = {
    'SUCCESS':    'authorized',
    'REFUSED':    'declined',
    'EXPIRED':    'expired',
    'FRAUD':      'declined',
    'BLACKLISTED':'declined',
    'CANCELLED':  'cancelled',
    'USER_CANCELLED': 'cancelled'
  };
  const newStatus = statusMap[orderStatus] || 'failed';

  // Extraer datos de la tarjeta de la transacción si están disponibles
  const tx = order.transactions?.[0];
  const source = tx?.source;

  try {
    const update = {
      status:       newStatus,
      updatedAt:    new Date(),
      connectorUsed: 'payNoPain'
    };

    // Si el pago fue exitoso, guardamos datos del token de tarjeta
    if (source?.token) {
      update.cardToken     = source.token;
      update.bin           = source.bin ? String(source.bin) : undefined;
      update.cardBrand     = source.brand || undefined;
      update.issuerCountry = source.country || undefined;
      update.cardType      = source.type || undefined;
      update.issuerName    = source.bank || undefined;
    }

    await Transaction.findOneAndUpdate(
      { paymentId },
      { $set: update }
    );

    logger.info('webhookController: transacción actualizada', {
      component: 'webhook',
      event: 'PAYNOPAIN_WEBHOOK_PROCESSED',
      data: { paymentId, newStatus }
    });
  } catch (err) {
    logger.error('webhookController: error actualizando transacción', {
      component: 'webhook',
      event: 'PAYNOPAIN_WEBHOOK_DB_ERROR',
      data: { paymentId, error: err.message }
    });
    // Aun así respondemos 200 — Paylands no debe reintentar por errores nuestros de DB
  }

  // Paylands espera un 200 para no reintentar la notificación
  return res.status(200).json({ success: true });
}

module.exports = { handlePayNoPainWebhook };
