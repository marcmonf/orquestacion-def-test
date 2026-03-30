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
 * Paylands requiere API_KEY como username, password vacío.
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
        'Authorization': buildAuthHeader(apiKey)
      }
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
 * Hash = SHA256(JSON(order + client + extra_data) + signature)
 */
function validateNotificationHash(notification, signatureKey) {
  try {
    const arr = {
      order:      notification.order,
      client:     notification.client,
      extra_data: notification.extra_data || null
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
 * Crea una orden de pago en Paylands.
 */
async function authorize(paymentData) {
  if (!API_KEY || !SIGNATURE || !SERVICE_UUID) {
    logger.error('payNoPainConnector: faltan variables de entorno', {
      component: 'connector',
      event: 'PAYNOPAIN_CONFIG_ERROR'
    });
    return { success: false, responseCode: 'config_error', processorReference: null };
  }

  const {
    paymentId,
    amount,
    returnUrl,
    merchantId,
    merchantReference
  } = paymentData;

  // La signature se envía tal cual — es el valor literal de PAYNOPAIN_SIGNATURE
  const body = {
    signature:        SIGNATURE,
    amount,
    operative:        'AUTHORIZATION',
    secure:           true,
    service:          SERVICE_UUID,
    customer_ext_id:  merchantId || 'monetiser-user',
    description:      merchantReference || paymentId,
    additional:       paymentId,
    url_post:         `${SERVER_URL}/webhooks/paynopain`,
    url_ok:           returnUrl || `${SERVER_URL}/payment/success`,
    url_ko:           returnUrl || `${SERVER_URL}/payment/error`,
    save_card:        false,
    reference:        paymentId
  };

  logger.info('payNoPainConnector: creando orden', {
    component: 'connector',
    event: 'PAYNOPAIN_ORDER_CREATE',
    data: { paymentId, amount, env: ENV }
  });

  let response;
  try {
    response = await postJson('/payment', body, API_KEY);
  } catch (err) {
    logger.error('payNoPainConnector: error de red', {
      component: 'connector',
      event: 'PAYNOPAIN_NETWORK_ERROR',
      data: { error: err.message }
    });
    return { success: false, responseCode: 'network_error', processorReference: null };
  }

  logger.info('payNoPainConnector: respuesta Paylands', {
    component: 'connector',
    event: 'PAYNOPAIN_ORDER_RESPONSE',
    data: { status: response.status, code: response.body?.code }
  });

  if (response.status !== 200 || response.body?.code !== 200) {
    logger.warn('payNoPainConnector: orden rechazada', {
      component: 'connector',
      event: 'PAYNOPAIN_ORDER_REJECTED',
      data: { status: response.status, body: response.body }
    });
    return {
      success: false,
      responseCode: `paynopain_${response.status}`,
      processorReference: null
    };
  }

  const order = response.body.order;
  const redirectUrl = order?.urls?.payment_card;
  const orderUuid   = order?.uuid;

  logger.info('payNoPainConnector: orden creada OK', {
    component: 'connector',
    event: 'PAYNOPAIN_ORDER_CREATED',
    data: { paymentId, orderUuid, env: ENV }
  });

  return {
    success:            true,
    status:             'pending_redirect',
    redirectUrl,
    orderUuid,
    processorReference: orderUuid
  };
}

function isSoftDecline() {
  return false;
}

module.exports = {
  name: 'payNoPain',
  authorize,
  isSoftDecline,
  validateNotificationHash,
  SIGNATURE
};
