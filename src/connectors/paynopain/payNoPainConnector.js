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
 * Sigue siendo útil para merchants que usen el flujo hosted clásico sin 3DS.
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
    additional:   paymentData.paymentId,
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
 * Crea una orden de pago con 3DS activado y extra_data para tokenización de tarjeta.
 *
 * Este es el flujo correcto para el Hosted Checkout de Monetiser con Paylands:
 *   1. Monetiser crea la orden con secure:true + extra_data (cof + profile + address)
 *   2. Paylands devuelve un token de orden
 *   3. Monetiser construye la URL /payment/process/{TOKEN} y la carga en iFrame
 *   4. El usuario ve el checkout de Paylands, introduce tarjeta y completa 3DS en su banco
 *   5. Paylands notifica el resultado por webhook (POST /webhooks/paynopain)
 *
 * Los datos de customer_ext_id, profile y address son fijos para la demo de Monetiser.
 * En producción estos campos deben venir del merchant en el body del pago.
 *
 * @param {Object} paymentData
 *   - paymentId: string
 *   - merchantId: string
 *   - amount: number (minor units, ej: 1000 = 10.00 EUR)
 *   - currency: string
 *   - callbackUrl: string (opcional)
 */
async function createOrder3DS(paymentData) {
  const apiKey      = API_KEY;
  const signature   = SIGNATURE;
  const serviceUuid = SERVICE_UUID;

  if (!apiKey || !signature || !serviceUuid) {
    return { success: false, error: 'PayNoPain credentials not configured' };
  }

  // Datos fijos de demo para Inditex sandbox.
  // En producción se recibirán del merchant via API.
  const DEMO_CUSTOMER_EXT_ID = 'demo-inditex-user-001';
  const DEMO_EXTRA_DATA = {
    cof: {
      reason: 'OTHER',
    },
    profile: {
      first_name: 'John',
      last_name:  'Smith',
      email:      'johnsmith@test.com',
      phone: {
        number: '666554411',
        prefix: '+34',
      },
    },
    address: {
      city:       'Castellon',
      country:    'ESP',
      address1:   'Avda. Mayor 24',
      zip_code:   '12006',
      state_code: 'Spain',
    },
  };

  const orderBody = {
    operative:       'AUTHORIZATION',
    service:         serviceUuid,
    order_id:        paymentData.paymentId,
    amount:          paymentData.amount,
    description:     `Pago ${paymentData.merchantId}`,
    signature:       signature,
    secure:          true,                   // ← 3DS obligatorio
    customer_ext_id: DEMO_CUSTOMER_EXT_ID,   // ← identificador del usuario
    url_post:        `${SERVER_URL}/webhooks/paynopain`,
    additional:      paymentData.paymentId,
    extra_data:      DEMO_EXTRA_DATA,
  };

  logger.info('PAYNOPAIN_CREATE_ORDER_3DS', {
    component: 'payNoPainConnector',
    data: {
      paymentId: paymentData.paymentId,
      amount:    paymentData.amount,
      secure:    true,
    },
  });

  try {
    const res = await postJson('/payment', orderBody, apiKey);

    if (res.status !== 200 || !res.body?.order?.token) {
      logger.error('PAYNOPAIN_CREATE_ORDER_3DS_ERROR', {
        component: 'payNoPainConnector',
        data: { status: res.status, body: res.body },
      });
      return {
        success: false,
        error: res.body?.message || `Error creating 3DS order (status ${res.status})`,
      };
    }

    const orderToken = res.body.order.token;

    // URL del checkout de Paylands donde el usuario introduce tarjeta y hace 3DS.
    // Esta URL se carga en el iFrame de Monetiser.
    const checkoutUrl = ENV === 'production'
      ? `https://api.paylands.com/v1/payment/process/${orderToken}`
      : `https://api.paylands.com/v1/sandbox/payment/process/${orderToken}`;

    logger.info('PAYNOPAIN_CREATE_ORDER_3DS_OK', {
      component: 'payNoPainConnector',
      data: { paymentId: paymentData.paymentId, orderToken, checkoutUrl },
    });

    return {
      success:            true,
      orderToken,
      processorReference: orderToken,
      checkoutUrl,
    };
  } catch (err) {
    logger.error('PAYNOPAIN_CREATE_ORDER_3DS_EXCEPTION', {
      component: 'payNoPainConnector',
      data: { error: err.message },
    });
    return { success: false, error: err.message };
  }
}

/**
 * Cobro S2S usando un token del Proxy PCI como source_uuid.
 *
 * Este es el flujo del Proxy PCI para cobros recurrentes / MIT
 * donde el usuario ya tiene una tarjeta tokenizada y no necesita
 * pasar por el checkout de Paylands de nuevo.
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
 *   - callbackUrl: string (opcional)
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

  // Flujo ProxyFields estándar (sin perfil PCI especial):
  // 1. POST /payment con source_uuid = card UUID del Proxy PCI
  // 2. Respuesta incluye order.token y urls.3ds_tokenized
  // 3. El frontend carga esa URL en el mismo iframe para el challenge 3DS del banco
  const orderBody = {
    operative:       'AUTHORIZATION',
    service:         serviceUuid,
    order_id:        paymentData.paymentId,
    amount:          paymentData.amount,
    description:     `Pago ${paymentData.merchantId}`,
    signature:       signature,
    secure:          true,
    source_uuid:     paymentData.cardToken,
    customer_ext_id: paymentData.paymentId,
    url_post:        `${SERVER_URL}/webhooks/paynopain`,
    additional:      paymentData.paymentId,
    save_card:       false,
  };

  try {
    const orderRes = await postJson('/payment', orderBody, apiKey);

    logger.info('PAYNOPAIN_CHARGE_TOKEN_ORDER_RESULT', {
      component: 'payNoPainConnector',
      data: {
        status:      orderRes.status,
        orderStatus: orderRes.body?.order?.status,
        urls:        orderRes.body?.order?.urls,
      },
    });

    if (orderRes.status !== 200 || !orderRes.body?.order?.token) {
      logger.error('PAYNOPAIN_CHARGE_TOKEN_ORDER_ERROR', {
        component: 'payNoPainConnector',
        data: { status: orderRes.status, body: orderRes.body },
      });
      return {
        success: false,
        error: orderRes.body?.message || `Error creando orden (status ${orderRes.status})`,
      };
    }

    const order      = orderRes.body.order;
    const orderToken = order.token;
    const orderUuid  = order.uuid;

    // URL de 3DS tokenizado — el banco autentica directamente sin formulario de tarjeta
    const threeDsUrl = order.urls?.['3ds_tokenized']
      || `${BASE_URL}/payment/tokenized/${orderToken}`;

    logger.info('PAYNOPAIN_CHARGE_TOKEN_3DS_URL', {
      component: 'payNoPainConnector',
      data: { paymentId: paymentData.paymentId, orderUuid, threeDsUrl },
    });

    return {
      success:            false,
      requires3DS:        true,
      threeDsUrl,
      orderUuid,
      orderToken,
      processorReference: orderUuid,
      error:              null,
    };

  } catch (err) {
    logger.error('PAYNOPAIN_CHARGE_TOKEN_EXCEPTION', {
      component: 'payNoPainConnector',
      data: { error: err.message },
    });
    return { success: false, error: err.message };
  }
}

module.exports = {
  createOrder,
  createOrder3DS,
  chargeWithToken,
  validateNotificationHash,
  SIGNATURE,
};
