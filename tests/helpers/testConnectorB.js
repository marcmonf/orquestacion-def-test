// tests/helpers/testConnectorB.js
'use strict';
//
// CONECTOR DE PRUEBA "B" — existe SOLO en los tests (nunca en src/).
//
// Es un PSP inventado, en memoria, que demuestra que el contrato
// (src/connectors/contract.js) basta para enchufar un segundo adquirente sin
// tocar el núcleo: pasa la misma suite de contrato que Paylands
// (tests/contract/connectorContract.js) y el ciclo de vida real
// (paymentLifecycleService) lo usa sin cambios.
//
// No se parece a ningún PSP real a propósito: no hay credenciales de ningún
// otro PSP y no se inventan sus campos ni endpoints.
//
// Tokens de prueba (lo que devolvería su proveedor de campos):
//   tok_approve  → autorizado
//   tok_3ds      → requiere autenticación (redirect)
//   tok_decline  → rechazado por el emisor
//   tok_timeout  → sin respuesta (resultado desconocido)

const crypto = require('crypto');
const { defineConnector } = require('../../src/connectors/contract');
const { makeError } = require('../../src/connectors/errors');

function createTestConnectorB({ id = 'pspB' } = {}) {
  const orders = new Map();   // ref → { amount, captured, refunded, status }
  const calls = [];

  function needCreds(ctx) {
    const c = (ctx && ctx.credentials) || {};
    if (!c.apiKey) return makeError('configuration_error', 'pspB: falta apiKey');
    return null;
  }

  const STATUS = { AUTH: 'authorized', CAPT: 'captured', PCAP: 'partially_captured', VOID: 'cancelled', DECL: 'declined', REFD: 'refunded', PREF: 'partially_refunded', PEND: 'pending' };

  const connector = defineConnector({
    id,
    displayName: 'PSP de prueba B (solo tests)',
    capabilities: {
      paymentMethods: ['card'],
      currencies: ['EUR', 'USD'],
      countries: ['ES', 'PT', 'FR'],
      deferredCapture: true, partialCapture: true, multipleCaptures: true,
      cancel: true, refund: true, partialRefund: true,
      threeDS: true, tokenization: true, retrieve: true, webhooks: true,
      perAccountCredentials: true,
      checkout: { fieldsProvider: 'test_b_fields' },
      credentialFields: [
        { name: 'apiKey', secret: true, required: true },
        { name: 'webhookSecret', secret: true, required: true },
      ],
      testOnly: true,
    },

    async createPayment(input, ctx) {
      calls.push({ op: 'createPayment', input });
      const credErr = needCreds(ctx);
      if (credErr) return { status: 'error', processorReference: null, error: credErr };
      const ref = `B-${input.paymentId}`;
      switch (input.sourceToken) {
        case 'tok_approve':
          orders.set(ref, { amount: input.amount, captured: 0, refunded: 0, raw: 'AUTH' });
          return { status: 'authorized', processorReference: ref };
        case 'tok_3ds':
          orders.set(ref, { amount: input.amount, captured: 0, refunded: 0, raw: 'PEND' });
          return { status: 'requires_action', processorReference: ref, action: { type: 'redirect', url: `https://psp-b.invalid/3ds/${ref}` } };
        case 'tok_decline':
          return { status: 'declined', processorReference: ref, error: makeError('card_declined', 'do_not_honor') };
        case 'tok_timeout':
          return { status: 'error', processorReference: null, error: makeError('timeout') };
        default:
          return { status: 'error', processorReference: null, error: makeError('invalid_request', 'token desconocido') };
      }
    },

    async capture({ processorReference, amount }, ctx) {
      calls.push({ op: 'capture', processorReference, amount });
      const credErr = needCreds(ctx); if (credErr) return { success: false, error: credErr };
      const o = orders.get(processorReference);
      if (!o) return { success: false, error: makeError('invalid_request', 'orden desconocida') };
      if (!['AUTH', 'PCAP'].includes(o.raw)) return { success: false, error: makeError('conflict', `estado ${o.raw}`) };
      const amt = amount ?? (o.amount - o.captured);
      if (o.captured + amt > o.amount) return { success: false, error: makeError('invalid_request', 'excede') };
      o.captured += amt;
      o.raw = o.captured === o.amount ? 'CAPT' : 'PCAP';
      return { success: true, status: o.raw, capturedTotal: o.captured };
    },

    async cancel({ processorReference }, ctx) {
      calls.push({ op: 'cancel', processorReference });
      const credErr = needCreds(ctx); if (credErr) return { success: false, error: credErr };
      const o = orders.get(processorReference);
      if (!o || o.raw !== 'AUTH') return { success: false, error: makeError('conflict', 'no anulable') };
      o.raw = 'VOID';
      return { success: true, status: 'VOID' };
    },

    async refund({ processorReference, amount }, ctx) {
      calls.push({ op: 'refund', processorReference, amount });
      const credErr = needCreds(ctx); if (credErr) return { success: false, error: credErr };
      const o = orders.get(processorReference);
      if (!o || o.captured === 0) return { success: false, error: makeError('conflict', 'sin captura previa') };
      const amt = amount ?? (o.captured - o.refunded);
      if (o.refunded + amt > o.captured) return { success: false, error: makeError('invalid_request', 'excede') };
      o.refunded += amt;
      o.raw = o.refunded === o.captured ? 'REFD' : 'PREF';
      return { success: true, status: o.raw, refundedTotal: o.refunded };
    },

    async retrieve({ processorReference }) {
      const o = orders.get(processorReference);
      if (!o) return { success: false, error: makeError('invalid_request', 'orden desconocida') };
      return { success: true, rawStatus: o.raw, status: STATUS[o.raw] || null };
    },

    // Firma propia de "B": HMAC-SHA256 hex del cuerpo crudo con webhookSecret.
    verifyWebhook({ rawBody, headers } = {}, ctx = {}) {
      const secret = ctx.credentials && ctx.credentials.webhookSecret;
      const sig = headers && (headers['x-pspb-signature'] || headers['X-PspB-Signature']);
      if (!secret || !sig || typeof rawBody !== 'string') return false;
      const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
      const a = Buffer.from(expected); const b = Buffer.from(String(sig));
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    },

    parseWebhook(body) {
      if (!body || !body.ref) return null;
      return { processorReference: String(body.ref), paymentId: body.merchant_ref || null, rawStatus: body.state, status: STATUS[body.state] || null, amount: Number.isFinite(body.amount) ? body.amount : null };
    },

    mapStatus: (raw) => STATUS[String(raw || '').toUpperCase()] || null,

    normalizeError(raw) {
      if (raw && raw.code && raw.retryable !== undefined) return raw;
      return makeError('unknown', typeof raw === 'string' ? raw : 'pspB error');
    },
  });

  return { connector, orders, calls, RAW_STATUSES: Object.keys(STATUS) };
}

module.exports = { createTestConnectorB };
