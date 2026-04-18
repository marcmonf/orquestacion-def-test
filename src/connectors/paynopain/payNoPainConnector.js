// src/connectors/paynopain/payNoPainConnector.js
'use strict';

const crypto = require('crypto');
const https  = require('https');
const URL    = require('url').URL;
const logger = require('../../utils/logger');

const ENV          = process.env.PAYNOPAIN_ENV || 'sandbox';
const API_KEY      = process.env.PAYNOPAIN_API_KEY;
const SIGNATURE    = process.env.PAYNOPAIN_SIGNATURE;
const SERVICE_UUID = process.env.PAYNOPAIN_SERVICE_UUID;

const BASE_URL = ENV === 'production'
  ? 'https://api.paylands.com/v1'
  : 'https://api.paylands.com/v1/sandbox';

const SERVER_URL = process.env.SERVER_URL || 'https://orquestacion-def-test.onrender.com';

/**
 * Genera el header Authorization en formato Basic Auth.
 */
function buildAuthHeader(apiKey) {
  const encoded = Buffer.from(`${apiKey}:`).toString('base64');
  return `Basic ${encoded}`;
}

/**
 * Hace una petición POST JSON a la API de Paylands.
 */
function postJson(path, body, apiKey) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const u = new URL(`${BASE_URL}${path}`);

    const opts = {
      hostname: u.hostname,
      port: 443,
      path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(payload.length),
        'Authorization': buildAuthHeader(apiKey),
      },
    };

    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * Valida el hash de una notificación entrante de Paylands.
 */
function validateNotificationHash(notification, signatureKey) {
  try {
    const arr = {
      order:      notification.order,
      client:     notification.client,
      extra_data: notification.extra_data || null,
    };
    const data = JSON.stringify(arr);
    const expected = crypto.createHash('sha256')
      .update(data + signatureKey)
      .digest('hex');
    return expected === notification.validation_hash;
  } catch {
    return false;
  }
}

/**
 * Crea una orden de pago Hosted Checkout en Paylands (flujo con redirección).
 * Sigue siendo útil para merchants que usen el flujo hosted clásico.
 */
async function createOrder(paymentData) {
  const apiKey      = API_KEY;
  const signature   = SIGNATURE;
  const serviceUuid = SERVICE_UUID;

  if (!apiKey || !signature || !serviceUuid) {
    return { success: false, error: 'PayNoPain credentials not configured' };
  }

  const orderBody = {
    operative:    'AUTHORIZATION',
    service:      serviceUuid,
    order_id:     paymentData.paymentId,
    amount:       paymentData.amount,
    description:  `Pago ${paymentData.merchantId}`,
    signature:    signature,
    secure:       false,
    url_post:     `${SERVER_URL}/webhooks/paynopain`,
  };

  try {
    const res = await postJson('/payment', orderBody, apiKey);

    if (res.status !== 200 || !res.body?.order?.token) {
      logger.error('PAYNOPAIN_CREATE_ORDER_ERROR', {
        component: 'payNoPainConnector',
        data: { status: res.status, body: res.body },
      });
      return { success: false, error: res.body?.message || 'Error creating order' };
    }

    const orderUuid = res.body.order.token;
    const redirectUrl = `https://api.paylands.com/${ENV === 'production' ? '' : 'sandbox/'}payment/${orderUuid}`;

    return {
      success: true,
      orderUuid,
      processorReference: orderUuid,
      redirectUrl,
    };
  } catch (err) {
    logger.error('PAYNOPAIN_CREATE_ORDER_EXCEPTION', {
      component: 'payNoPainConnector',
      data: { error: err.message },
    });
    return { success: false, error: err.message };
  }
}

/**
 * Cobro S2S usando un token del Proxy PCI como source_uuid.
 *
 * Este es el flujo del Proxy PCI (iFrame de Monetiser):
 * 1. El browser tokenizó el PAN via ProxyFields → Paylands tiene el PAN en bóveda
 * 2. getTokenizationResults() nos devuelve el masked token
 * 3. Aquí usamos ese token como source_uuid para crear la orden + ejecutar el cobro
 *
 * @param {Object} paymentData
 *   - paymentId: string
 *   - merchantId: string
 *   - amount: number (en minor units, ej: 1000 = 10.00 EUR)
 *   - currency: string
 *   - cardToken: string  ← token obtenido de getTokenizationResults().token
 *   - expiryMonth: string
 *   - expiryYear: string
 *   - cardHolder: string
 *   - callbackUrl: string (opcional, para webhook de notificación)
 */
async function chargeWithToken(paymentData) {
  const apiKey      = API_KEY;
  const signature   = SIGNATURE;
  const serviceUuid = SERVICE_UUID;

  if (!apiKey || !signature || !serviceUuid) {
    return { success: false, error: 'PayNoPain credentials not configured' };
  }

  if (!paymentData.cardToken) {
    return { success: false, error: 'cardToken es obligatorio para chargeWithToken' };
  }

  // Paso 1: Crear la orden en Paylands usando el token PCI como source_uuid
  const orderBody = {
    operative:    'AUTHORIZATION',
    service:      serviceUuid,
    order_id:     paymentData.paymentId,
    amount:       paymentData.amount,
    description:  `Pago ${paymentData.merchantId}`,
    signature:    signature,
    secure:       false,
    source_uuid:  paymentData.cardToken,  // ← token del Proxy PCI
    url_post:     `${SERVER_URL}/webhooks/paynopain`,
  };

  try {
    const orderRes = await postJson('/payment', orderBody, apiKey);

    if (orderRes.status !== 200 || !orderRes.body?.order?.token) {
      logger.error('PAYNOPAIN_CHARGE_TOKEN_ORDER_ERROR', {
        component: 'payNoPainConnector',
        data: { status: orderRes.status, body: orderRes.body },
      });
      return {
        success: false,
        error: orderRes.body?.message || 'Error creating order with token',
      };
    }

    const orderUuid = orderRes.body.order.token;

    // Paso 2: Ejecutar el cobro S2S (webservice payment)
    // Paylands webservice: POST /payment/{orderUuid}/webservice
    const wsBody = {
      operative:   'AUTHORIZATION',
      expiry_month: String(paymentData.expiryMonth || '').padStart(2, '0'),
      expiry_year:  String(paymentData.expiryYear || ''),
      holder:       paymentData.cardHolder || 'Cardholder',
    };

    const wsRes = await postJson(`/payment/${orderUuid}/webservice`, wsBody, apiKey);

    logger.info('PAYNOPAIN_CHARGE_TOKEN_RESULT', {
      component: 'payNoPainConnector',
      data: {
        orderUuid,
        wsStatus: wsRes.status,
        operative: wsRes.body?.order?.operative,
        status: wsRes.body?.order?.status,
      },
    });

    // Status 300 = procesado (aprobado o denegado según operative)
    // Status 200 también puede indicar OK según contexto
    const wsBody2 = wsRes.body;
    const orderStatus = wsBody2?.order?.status;
    // Paylands status: 1=pending, 2=processing, 3=paid, 4=cancelled, 5=failed, 6=refunded
    const approved = orderStatus === 3 || wsRes.status === 300;

    return {
      success: approved,
      orderUuid,
      processorReference: orderUuid,
      paylandsStatus: orderStatus,
      error: approved ? null : (wsBody2?.order?.message || `Declined (status ${orderStatus})`),
    };
  } catch (err) {
    logger.error('PAYNOPAIN_CHARGE_TOKEN_EXCEPTION', {
      component: 'payNoPainConnector',
      data: { error: err.message },
    });
    return { success: false, error: err.message };
  }
}

// AÑADIR esta función al final de payNoPainConnector.js,
// justo antes de module.exports, y exportarla.

/**
 * Ejecuta un reembolso contra la API de Paylands.
 *
 * Paylands endpoint: POST /payment/{orderUuid}/refund
 * Docs: https://docs.paylands.com/api#refund
 *
 * @param {Object} refundData
 *   - processorReference {string}  orderUuid de Paylands (campo en Transaction)
 *   - amount             {number}  importe en minor units (ej: 1000 = 10.00 EUR)
 *   - reason             {string}  motivo del refund (opcional)
 */
async function refund(refundData) {
  const apiKey = API_KEY;

  if (!apiKey) {
    return { success: false, error: 'PayNoPain credentials not configured' };
  }

  const { processorReference, amount, reason } = refundData;

  if (!processorReference) {
    return { success: false, error: 'processorReference (orderUuid) es obligatorio para el refund' };
  }
  if (!amount || amount <= 0) {
    return { success: false, error: 'amount debe ser mayor que 0' };
  }

  const body = {
    amount,
    ...(reason && { description: reason }),
  };

  try {
    const res = await postJson(`/payment/${processorReference}/refund`, body, apiKey);

    logger.info('PAYNOPAIN_REFUND_RESULT', {
      component: 'payNoPainConnector',
      data: {
        processorReference,
        amount,
        status: res.status,
        body: res.body,
      },
    });

    // Paylands devuelve 200 + order.status === 'REFUNDED' en caso de éxito
    const orderStatus = res.body?.order?.status;
    const success = res.status === 200 && (orderStatus === 'REFUNDED' || orderStatus === 6);

    if (!success) {
      return {
        success: false,
        error: res.body?.message || `Refund failed (status ${res.status}, orderStatus ${orderStatus})`,
        raw: res.body,
      };
    }

    return {
      success: true,
      processorReference,
      refundedAmount: amount,
      orderStatus,
      raw: res.body,
    };
  } catch (err) {
    logger.error('PAYNOPAIN_REFUND_EXCEPTION', {
      component: 'payNoPainConnector',
      data: { error: err.message },
    });
    return { success: false, error: err.message };
  }
}

module.exports = {
  createOrder,
  chargeWithToken,
  validateNotificationHash,
  refund,               // ← añadir esta línea
};

