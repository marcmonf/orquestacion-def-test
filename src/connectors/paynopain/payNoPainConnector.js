// src/connectors/paynopain/payNoPainConnector.js
'use strict';

const crypto = require('crypto');
const https  = require('https');
const URL    = require('url').URL;
const logger = require('../../utils/logger');

/**
 * Conector PayNoPain (Paylands) — Integración simple con carta de pago.
 *
 * Flujo:
 *   1. authorize() → crea orden en Paylands → devuelve redirectUrl
 *   2. Usuario completa el pago en la carta de pago de Paylands
 *   3. Paylands notifica el resultado vía webhook a /webhooks/paynopain
 *
 * Autenticación: HTTP Basic Auth con API_KEY como username (base64).
 * Firma: MD5(amount + operative + service_uuid + signature).
 * Entorno: sandbox si PAYNOPAIN_ENV !== 'production'.
 */

const ENV         = process.env.PAYNOPAIN_ENV || 'sandbox';
const API_KEY     = process.env.PAYNOPAIN_API_KEY;
const SIGNATURE   = process.env.PAYNOPAIN_SIGNATURE;
const SERVICE_UUID = process.env.PAYNOPAIN_SERVICE_UUID;

const BASE_URL = ENV === 'production'
  ? 'https://api.paylands.com/v1'
  : 'https://api.paylands.com/v1/sandbox';

// URL base del servidor de Monetiser — usada como url_post para webhooks
const SERVER_URL = process.env.SERVER_URL || 'https://orquestacion-def-test.onrender.com';

/**
 * Calcula la firma MD5 requerida por Paylands.
 * Fórmula: MD5(amount + operative + service_uuid + signature_key)
 */
function calcSignature(amount, operative, serviceUuid, signatureKey) {
  const raw = `${amount}${operative}${serviceUuid}${signatureKey}`;
  return crypto.createHash('md5').update(raw).digest('hex');
}

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
 *
 * Devuelve:
 *   { success: true, redirectUrl, orderUuid, token }  — si OK
 *   { success: false, responseCode, error }           — si falla
 *
 * IMPORTANTE: success:true NO significa pago completado.
 * Significa que la orden fue creada y hay una URL donde el usuario
 * debe completar el pago. El resultado final llega por webhook.
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
    amount,       // en céntimos (ya viene así desde paymentService)
    currency,
    merchantId,
    returnUrl,
    merchantReference
  } = paymentData;

  const operative = 'AUTHORIZATION';

  // Calcular firma
  const signature = calcSignature(amount, operative, SERVICE_UUID, SIGNATURE);

  const body = {
    amount,
    operative,
    signature,
    service:          SERVICE_UUID,
    customer_ext_id:  merchantId || 'monetiser-user',
    description:      merchantReference || paymentId,
    additional:       paymentId, // lo usamos para correlacionar en el webhook
    url_post:         `${SERVER_URL}/webhooks/paynopain`,
    url_ok:           returnUrl || `${SERVER_URL}/payment/success`,
    url_ko:           returnUrl || `${SERVER_URL}/payment/error`,
    secure:           true,
    save_card:        false,
    reference:        paymentId
  };

  logger.info('payNoPainConnector: creando orden', {
    component: 'connector',
    event: 'PAYNOPAIN_ORDER_CREATE',
    data: { paymentId, amount, operative, env: ENV }
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
  const token       = order?.token;

  logger.info('payNoPainConnector: orden creada OK', {
    component: 'connector',
    event: 'PAYNOPAIN_ORDER_CREATED',
    data: { paymentId, orderUuid, env: ENV }
  });

  // Devolvemos success:true con redirectUrl
  // El paymentService debe interpretar esto como "pendiente de pago del usuario"
  return {
    success:            true,
    status:             'pending_redirect',
    redirectUrl,
    orderUuid,
    token,
    processorReference: orderUuid
  };
}

/**
 * El conector PayNoPain no distingue soft decline — todos los errores
 * son hard decline para efectos de la lógica de reintentos.
 */
function isSoftDecline() {
  return false;
}

module.exports = {
  name: 'payNoPain',
  authorize,
  isSoftDecline,
  validateNotificationHash,
  SIGNATURE // exportado para uso en webhookController
};
