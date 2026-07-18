// src/controllers/serverPaymentController.js
'use strict';

const { v4: uuidv4 } = require('uuid');
const Transaction  = require('../models/Transaction');
const logger       = require('../utils/logger');
const auditLogger  = require('../logs/auditLogger');
const { processCardPayment } = require('../services/paymentService');

const {
  ServerPaymentRequestDTO,
  buildServerPaymentCreateResponse,
  buildServerPaymentStatusResponse
} = require('../dtos/serverPaymentDTO');

// ─── Helpers ────────────────────────────────────────────────────────────────

function mapStatusToStatusOutput(status) {
  switch (status) {
    case 'authorized':
    case 'approved':
      return { statusCode: 'AUTHORIZED', isFinal: true,  statusCategory: 'SUCCESS' };
    case 'pending_3ds':
      return { statusCode: 'PENDING_3DS', isFinal: false, statusCategory: 'PENDING' };
    case 'declined':
    case 'refused':
    case 'failed':
      return { statusCode: 'REFUSED',    isFinal: true,  statusCategory: 'FAILED'  };
    default:
      return { statusCode: 'UNKNOWN',    isFinal: false, statusCategory: 'UNKNOWN' };
  }
}

function shouldRequire3DSChallenge(amount) {
  const threshold = Number(process.env.THREEDS_CHALLENGE_THRESHOLD || 0);
  return threshold > 0 ? amount >= threshold : false;
}

function resolveMerchantIdFromRequest(req) {
  if (req.params?.merchantId) return req.params.merchantId;
  if (req.merchantId)         return req.merchantId;
  if (typeof req.merchant === 'string') return req.merchant;
  if (req.merchant?.merchantId)         return req.merchant.merchantId;
  return null;
}

// ─── POST /:merchantId/payments/server ──────────────────────────────────────

async function createServerPayment(req, res) {
  const body = req.body || {};

  if (Object.keys(body).length === 0) {
    return res.status(400).json({
      success: false,
      error: 'empty_body',
      detail: 'Request body is empty. Ensure you are sending JSON and Content-Type: application/json'
    });
  }

  // ── Política TOKENS-ONLY (PCI SAQ A) ────────────────────────────────────────
  // El PAN NUNCA entra por la API S2S. Se rechaza cardNumber/cvv en crudo con un
  // mensaje claro, ANTES de validar la estructura, para que el motivo no quede
  // sepultado entre otros errores de validación. Decisión ratificada 18 jul 2026
  // (ver DEV-LOG sección 5, fila S2S). La tarjeta se tokeniza con ProxyFields de
  // Paylands y el merchant envía el source_uuid resultante.
  const rawCard = body?.cardPaymentMethodSpecificInput?.card || {};
  if (rawCard.cardNumber || rawCard.cvv) {
    return res.status(400).json({
      success: false,
      error: 'card_data_not_accepted',
      detail:
        'S2S no acepta datos de tarjeta en crudo (cardNumber/cvv): Monetiser opera en ' +
        'scope PCI SAQ A y el PAN nunca debe transitar por la API. Tokeniza la tarjeta ' +
        'con ProxyFields de Paylands y envía el token (source_uuid) en el campo raíz ' +
        '"source_uuid" o en "cardPaymentMethodSpecificInput.token".'
    });
  }

  const { error, value } = ServerPaymentRequestDTO.validate(body, { abortEarly: false });
  if (error || !value) {
    return res.status(400).json({
      success: false,
      error: 'validation_error',
      detail: error ? error.details.map(d => d.message) : ['Invalid payload']
    });
  }

  const merchantId = resolveMerchantIdFromRequest(req);
  if (!merchantId) {
    return res.status(401).json({
      success: false,
      error: 'merchant_not_authenticated',
      detail: 'Unable to resolve merchantId from URL or request context'
    });
  }

const { cardPaymentMethodSpecificInput, order, hostedTokenizationId, hostedFieldsSessionId, feedbacks } = value;

  // Token de ProxyFields (Paylands source_uuid). Aceptado a nivel raíz o dentro
  // de cardPaymentMethodSpecificInput.token. Es obligatorio en el modelo tokens-only.
  const cardToken = value.source_uuid || cardPaymentMethodSpecificInput.token || null;
  if (!cardToken) {
    return res.status(400).json({
      success: false,
      error: 'missing_card_token',
      detail:
        'Falta el token de tarjeta. Tokeniza la tarjeta con ProxyFields de Paylands y ' +
        'envía el source_uuid en el campo raíz "source_uuid" o en ' +
        '"cardPaymentMethodSpecificInput.token".'
    });
  }

  const amount    = order.amountOfMoney.amount;
  const currency  = order.amountOfMoney.currencyCode;
  const returnUrl = cardPaymentMethodSpecificInput.threeDSecure.redirectionData.returnUrl;
  const callbackUrl = feedbacks?.webhookUrl ||
    (Array.isArray(feedbacks?.webhooksUrls) && feedbacks.webhooksUrls.length
      ? feedbacks.webhooksUrls[0]
      : null);
  const merchantReference = order?.references?.merchantReference
    ? String(order.references.merchantReference)
    : null;


  const timestamp = new Date();
  const paymentId = uuidv4();

  try {
    // ── 1. Decidir si requiere 3DS challenge ────────────────────────────────
    const requiresChallenge = shouldRequire3DSChallenge(amount);

    let merchantAction;
    let internalStatus;

    if (requiresChallenge) {
      const base3DS   = process.env.THREEDS_CHALLENGE_BASE_URL || '';
      const redirectURL = base3DS
        ? `${base3DS.replace(/\/$/, '')}/3ds-challenge?paymentId=${encodeURIComponent(paymentId)}`
        : `/3ds-challenge?paymentId=${encodeURIComponent(paymentId)}`;

      merchantAction = { actionType: 'REDIRECT', redirectData: { redirectURL } };
      internalStatus = 'pending_3ds';
    } else {
      merchantAction = { actionType: null, redirectData: null };
      internalStatus = 'pending'; // provisional hasta que el conector responda
    }

    // ── 2. Guardar transacción en MongoDB (estado provisional) ──────────────
    const txn = new Transaction({
      paymentId,
      merchantId,
      amount,
      currency,
      method: 'card',
      status: internalStatus,
      returnUrl,
      callbackUrl: callbackUrl || null,
      hostedTokenizationId:  hostedTokenizationId  || null,
      hostedFieldsSessionId: hostedFieldsSessionId || null,
      merchantReference:     merchantReference     || null,
      createdAt: timestamp
    });
    await txn.save();

    // ── 3. Si no requiere 3DS → llamar al conector a través del rule engine ──
    let connectorUsed = null;

    if (!requiresChallenge) {
      // paymentData TOKENS-ONLY: se pasa el source_uuid de ProxyFields como
      // cardToken. Ningún dato de tarjeta en crudo — el PAN ya fue rechazado
      // arriba. El conector payNoPain lo envía a Paylands como source_uuid.
      const paymentData = {
        paymentId,
        merchantId,
        amount,
        currency,
        method:    'card',
        cardToken,                 // ← source_uuid de ProxyFields
        // Contexto de routing sin PAN (no hay BIN disponible en tokens-only)
        bin:           null,
        cardBrand:     null,
        issuerCountry: null,
        cardType:      null,
      };

      const result = await processCardPayment(paymentData);

      // ── 4. Actualizar transacción con el resultado del conector ────────────
      connectorUsed = result.connectorUsed || null;

      if (result.status === 'pending_3ds') {
        // El conector real (payNoPain) devuelve un challenge 3DS tokenizado. No
        // es aprobado ni rechazado: el cardholder debe autenticarse en la URL y
        // Paylands cerrará la transacción por webhook (POST /webhooks/paynopain,
        // que localiza la tx por processorReference).
        internalStatus = 'pending_3ds';
        merchantAction = {
          actionType: 'REDIRECT',
          redirectData: { redirectURL: result.threeDsUrl || null },
        };
      } else {
        internalStatus = result.status === 'approved' ? 'authorized' : 'declined';
      }

      txn.status             = internalStatus;
      txn.processor          = connectorUsed;
      txn.processorReference = result.processorReference || null;  // ← orderUuid de Paylands
      txn.authCode           = result.processorReference || null;  // ← compatibilidad con campo legacy
      txn.updatedAt          = new Date();
      await txn.save();
    }

    // ── 5. Audit log ─────────────────────────────────────────────────────────
    auditLogger.info({
      action: 'SERVER_PAYMENT_CREATED',
      user: merchantId || 'unknown',
      details: {
        paymentId,
        amount,
        currency,
        method: 'card',
        internalStatus,
        connectorUsed,
        merchantReference: merchantReference || null
      },
      metadata: { createdAt: timestamp.toISOString(), flow: 'server_to_server' }
    });

    // ── 6. Respuesta al merchant ──────────────────────────────────────────────
    const statusOutput = mapStatusToStatusOutput(internalStatus);

    const responsePayload = buildServerPaymentCreateResponse({
      paymentId,
      merchantId,
      amount,
      currency,
      method:       'card',
      status:       internalStatus,
      connectorUsed: connectorUsed || 'dummyCard',
      merchantAction,
      statusOutput,
      timestamp:    timestamp.toISOString()
    });

    return res.status(200).json(responsePayload);

  } catch (e) {
    logger.error('Error in createServerPayment', { error: e.message });
    auditLogger.info({
      action: 'SERVER_PAYMENT_ERROR',
      user: merchantId || 'unknown',
      details: { error: e.message }
    });
    return res.status(500).json({
      success: false,
      error: 'internal_error',
      detail: e.message
    });
  }
}

// ─── GET /:merchantId/payments/server/:paymentId ─────────────────────────────

async function getServerPaymentStatus(req, res) {
  const { paymentId } = req.params;

  if (!paymentId) {
    return res.status(400).json({ success: false, error: 'validation_error', detail: 'paymentId is required' });
  }

  try {
    const tx = await Transaction.findOne({ paymentId }).lean();
    if (!tx) {
      return res.status(404).json({ success: false, error: 'not_found', detail: 'Payment not found' });
    }

    const statusOutput   = mapStatusToStatusOutput(tx.status);
    const responsePayload = buildServerPaymentStatusResponse(tx, statusOutput);
    return res.status(200).json(responsePayload);

  } catch (e) {
    return res.status(500).json({ success: false, error: 'internal_error', detail: e.message });
  }
}

module.exports = { createServerPayment, getServerPaymentStatus };
