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
    // DEFERRED (no AUTHORIZATION): retiene el saldo sin moverlo, para que
    // confirmation (capture) y cancellation (cancel) funcionen de verdad.
    // Verificado en docs.paylands.com/en/reference — confirmation/cancellation
    // solo aplican a órdenes DEFERRED.
    operative:    'DEFERRED',
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
    // DEFERRED (no AUTHORIZATION): retiene el saldo sin moverlo, para que
    // confirmation (capture) y cancellation (cancel) funcionen de verdad. [createOrder3DS]
    operative:       'DEFERRED',
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
    // DEFERRED (no AUTHORIZATION): retiene el saldo sin moverlo, para que
    // confirmation (capture) y cancellation (cancel) funcionen de verdad. [chargeWithToken]
    operative:       'DEFERRED',
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

/**
 * authorize() — punto de entrada del conector para el flujo S2S.
 *
 * Es la función que `connectorRegistry` (adaptPayNoPain) y `paymentService`
 * esperan encontrar en todo conector. Hasta ahora NO existía: si una regla de
 * routing enrutaba un pago S2S hacia `payNoPain`, reventaba con
 * `connector.authorize is not a function` (ver DEV-LOG, sección 5, fila S2S).
 *
 * Reutiliza `chargeWithToken` (ya en `operative: DEFERRED`). El S2S de Monetiser
 * opera en scope PCI SAQ A: aquí NUNCA entra un PAN, solo el `source_uuid` que
 * ProxyFields generó al tokenizar la tarjeta. Ese token llega en
 * `paymentData.cardToken` y se envía a Paylands como `source_uuid`.
 *
 * Normaliza la respuesta de `chargeWithToken` al contrato que consume el
 * registry/paymentService:
 *   - 3DS pendiente → { success:false, requires3DS:true, threeDsUrl, processorReference }
 *   - aprobado      → { success:true,  responseCode:'approved', processorReference }
 *   - rechazado     → { success:false, responseCode:<motivo>, processorReference }
 *
 * IMPORTANTE: en el flujo tokenizado de Paylands, una orden 200 con token SIEMPRE
 * devuelve un challenge 3DS (`requires3DS:true`), así que la rama "aprobado" es
 * defensiva — hoy el camino real termina en `pending_3ds` y lo cierra el webhook.
 *
 * @param {object} paymentData
 * @param {string} paymentData.cardToken  source_uuid de ProxyFields (obligatorio)
 * @param {string} paymentData.paymentId
 * @param {string} paymentData.merchantId
 * @param {number} paymentData.amount     céntimos
 * @param {string} [paymentData.currency]
 * @returns {Promise<{success:boolean, requires3DS:boolean, responseCode:string, processorReference:(string|null), threeDsUrl?:string, error:(string|null)}>}
 */
async function authorize(paymentData) {
  const data = paymentData || {};

  // Tokens-only: sin source_uuid no hay nada que cobrar. No llamamos a Paylands.
  if (!data.cardToken) {
    return {
      success: false,
      requires3DS: false,
      responseCode: 'missing_card_token',
      processorReference: null,
      error: 'cardToken (source_uuid de ProxyFields) es obligatorio para authorize',
    };
  }

  const res = await chargeWithToken(data);

  // chargeWithToken devuelve requires3DS:true con la URL de challenge tokenizado.
  if (res.requires3DS && res.threeDsUrl) {
    return {
      success: false,
      requires3DS: true,
      threeDsUrl: res.threeDsUrl,
      responseCode: 'pending_3ds',
      processorReference: res.processorReference || res.orderUuid || null,
      orderUuid: res.orderUuid || null,
      error: null,
    };
  }

  // Aprobado directo (defensivo: hoy chargeWithToken no llega aquí en tokenizado).
  if (res.success === true) {
    return {
      success: true,
      requires3DS: false,
      responseCode: 'approved',
      processorReference: res.processorReference || res.orderUuid || null,
      orderUuid: res.orderUuid || null,
      error: null,
    };
  }

  // Rechazo / error del procesador.
  return {
    success: false,
    requires3DS: false,
    responseCode: res.error || 'declined',
    processorReference: res.processorReference || res.orderUuid || null,
    orderUuid: res.orderUuid || null,
    error: res.error || null,
  };
}

/**
 * Captura (total o parcial) una orden previamente autorizada en Paylands.
 *
 * VERIFICADO contra la documentación oficial de Paylands (docs.paylands.com/en/reference):
 * el endpoint real se llama "Confirmation" — POST /payment/confirmation, con
 * order_uuid + amount (opcional) en el body.
 *
 * IMPORTANTE: según la doc oficial, este endpoint "charges the balance being
 * held by a DEFERRED operative" — es decir, SOLO aplica a órdenes creadas con
 * operative: DEFERRED. Nuestro createOrder() actual usa operative: AUTHORIZATION,
 * que captura el dinero de inmediato (paid:true en la creación). Sobre una orden
 * AUTHORIZATION no hay "balance retenido" que confirmar, así que aunque la URL ya
 * es la correcta, esto seguirá fallando sobre las órdenes actuales — hace falta
 * decidir si se cambia operative a DEFERRED (ver DEV-LOG).
 *
 * @param {object} data
 * @param {string} data.processorReference  UUID de la orden en Paylands (obligatorio)
 * @param {number} [data.amount]            importe a capturar en céntimos (opcional, total si se omite)
 * @returns {Promise<{success:boolean, ...}>}
 */
async function capture(data) {
  const apiKey    = API_KEY;
  const signature = SIGNATURE;

  if (!apiKey || !signature) {
    return { success: false, error: 'PayNoPain credentials not configured' };
  }

  const orderUuid = data.processorReference || data.orderUuid || data.order_uuid || null;
  if (!orderUuid) {
    return { success: false, error: 'missing_order_uuid' };
  }

  const body = {
    signature,
    order_uuid: orderUuid,
  };
  if (data.amount !== undefined && data.amount !== null) {
    body.amount = Number(data.amount);
  }

  try {
    const res = await postJson('/payment/confirmation', body, apiKey);

    const order = res.body?.order || null;
    const okStatuses = ['SUCCESS', 'CAPTURED', 'AUTHORIZED'];
    const okStatus = order && okStatuses.includes(String(order.status).toUpperCase());

    if (res.status !== 200 || !okStatus) {
      logger.error('PAYNOPAIN_CAPTURE_ERROR', {
        component: 'payNoPainConnector',
        data: { status: res.status, orderUuid, body: res.body },
      });
      return {
        success: false,
        error: res.body?.message || `capture_failed_status_${res.status}`,
        raw: res.body,
      };
    }

    logger.info('PAYNOPAIN_CAPTURE_OK', {
      component: 'payNoPainConnector',
      data: { orderUuid, captured: order.captured, status: order.status },
    });

    return {
      success: true,
      orderUuid,
      status: order.status,
      capturedTotal: order.captured ?? data.amount ?? null,
      raw: order,
    };
  } catch (err) {
    logger.error('PAYNOPAIN_CAPTURE_EXCEPTION', {
      component: 'payNoPainConnector',
      data: { orderUuid, error: err.message },
    });
    return { success: false, error: err.message };
  }
}

/**
 * Cancela (void) una orden autorizada en Paylands ANTES de capturarla.
 * No aplica a ordenes ya capturadas o reembolsadas — para eso existe refund().
 *
 * VERIFICADO contra la documentación oficial de Paylands (docs.paylands.com/en/reference):
 * el endpoint real es POST /payment/cancellation, con order_uuid en el body.
 *
 * IMPORTANTE: según la doc oficial, este endpoint "frees the balance being
 * held by a DEFERRED operative" — es decir, SOLO aplica a órdenes creadas con
 * operative: DEFERRED. Nuestro createOrder() actual usa operative: AUTHORIZATION,
 * que captura el dinero de inmediato (paid:true en la creación). Sobre una orden
 * AUTHORIZATION no hay "balance retenido" que liberar, así que aunque la URL ya
 * es la correcta, esto seguirá fallando sobre las órdenes actuales — hace falta
 * decidir si se cambia operative a DEFERRED (ver DEV-LOG).
 *
 * @param {object} data
 * @param {string} data.processorReference  UUID de la orden en Paylands (obligatorio)
 * @returns {Promise<{success:boolean, ...}>}
 */
async function voidOrder(data) {
  const apiKey    = API_KEY;
  const signature = SIGNATURE;

  if (!apiKey || !signature) {
    return { success: false, error: 'PayNoPain credentials not configured' };
  }

  const orderUuid = data.processorReference || data.orderUuid || data.order_uuid || null;
  if (!orderUuid) {
    return { success: false, error: 'missing_order_uuid' };
  }

  const body = {
    signature,
    order_uuid: orderUuid,
  };

  try {
    const res = await postJson('/payment/cancellation', body, apiKey);

    const order = res.body?.order || null;
    const okStatuses = ['CANCELLED', 'CANCELED', 'USER_CANCELLED'];
    const okStatus = order && okStatuses.includes(String(order.status).toUpperCase());

    if (res.status !== 200 || !okStatus) {
      logger.error('PAYNOPAIN_CANCEL_ERROR', {
        component: 'payNoPainConnector',
        data: { status: res.status, orderUuid, body: res.body },
      });
      return {
        success: false,
        error: res.body?.message || `cancel_failed_status_${res.status}`,
        raw: res.body,
      };
    }

    logger.info('PAYNOPAIN_CANCEL_OK', {
      component: 'payNoPainConnector',
      data: { orderUuid, status: order.status },
    });

    return {
      success: true,
      orderUuid,
      status: order.status,
      raw: order,
    };
  } catch (err) {
    logger.error('PAYNOPAIN_CANCEL_EXCEPTION', {
      component: 'payNoPainConnector',
      data: { orderUuid, error: err.message },
    });
    return { success: false, error: err.message };
  }
}

/**
 * Reembolsa (total o parcial) una orden ya pagada en Paylands.
 *
 * Doc oficial: POST /payment/refund
 *   body: { signature, order_uuid, amount? }
 *   - order_uuid: UUID de la orden en Paylands (nuestro processorReference)
 *   - amount: en céntimos (100 = 1,00 €). Si se omite → refund TOTAL.
 *   Respuesta 200 → order.status = "REFUNDED", con una transacción operative:"REFUND".
 *   Respuesta 429 → too many requests (Paylands limita reintentos de refund).
 *
 * @param {object} data
 * @param {string} data.processorReference  UUID de la orden en Paylands (obligatorio)
 * @param {number} [data.amount]            importe a reembolsar en céntimos (opcional)
 * @returns {Promise<{success:boolean, ...}>}
 */
async function refund(data) {
  const apiKey    = API_KEY;
  const signature = SIGNATURE;

  if (!apiKey || !signature) {
    return { success: false, error: 'PayNoPain credentials not configured' };
  }

  const orderUuid = data.processorReference || data.orderUuid || data.order_uuid || null;
  if (!orderUuid) {
    return { success: false, error: 'missing_order_uuid' };
  }

  // body base; amount solo si viene informado (si no → refund total en Paylands)
  const body = {
    signature,
    order_uuid: orderUuid,
  };
  if (data.amount !== undefined && data.amount !== null) {
    body.amount = Number(data.amount);   // en céntimos, igual que en /payment
  }

  try {
    const res = await postJson('/payment/refund', body, apiKey);

    const order = res.body?.order || null;
    const okStatuses = ['REFUNDED', 'PARTIALLY_REFUNDED'];
    const okStatus = order && okStatuses.includes(String(order.status).toUpperCase());

    if (res.status !== 200 || !okStatus) {
      logger.error('PAYNOPAIN_REFUND_ERROR', {
        component: 'payNoPainConnector',
        data: { status: res.status, orderUuid, body: res.body },
      });
      return {
        success: false,
        error: res.body?.message || `refund_failed_status_${res.status}`,
        raw: res.body,
      };
    }

    logger.info('PAYNOPAIN_REFUND_OK', {
      component: 'payNoPainConnector',
      data: { orderUuid, refunded: order.refunded, status: order.status },
    });

    return {
      success: true,
      orderUuid,
      status: order.status,           // "REFUNDED"
      refundedTotal: order.refunded,  // total reembolsado según Paylands (céntimos)
      raw: order,
    };
  } catch (err) {
    logger.error('PAYNOPAIN_REFUND_EXCEPTION', {
      component: 'payNoPainConnector',
      data: { orderUuid, error: err.message },
    });
    return { success: false, error: err.message };
  }
}

module.exports = {
  createOrder,
  createOrder3DS,
  chargeWithToken,
  authorize,
  validateNotificationHash,
  capture,
  void: voidOrder,
  refund,
  SIGNATURE,
};
