// src/connectors/dummy/index.js
'use strict';
//
// Conector SIMULADO `dummyCard` según el contrato (src/connectors/contract.js).
// Aprueba SIEMPRE sin mover dinero. Solo se registra en development/test o con
// ALLOW_DUMMY_CONNECTOR=true (invariante 6: nunca en producción). Ver
// src/services/connectorRegistry.js.

const low = require('./dummyCardConnector');
const { defineConnector } = require('../contract');
const { makeError } = require('../errors');

module.exports = defineConnector({
  id: 'dummyCard',
  displayName: 'Simulador (no mueve dinero)',
  capabilities: {
    paymentMethods: ['card'],
    currencies: ['EUR', 'USD', 'GBP'],
    deferredCapture: true, partialCapture: true, cancel: true, refund: true, partialRefund: true,
    simulated: true,
  },
  async createPayment(input) {
    const r = await low.authorize(input);
    return r.status === 'approved'
      ? { status: 'authorized', processorReference: r.transactionId, raw: r }
      : { status: 'declined', processorReference: r.transactionId || null, error: makeError('card_declined'), raw: r };
  },
  async capture(d) { const r = await low.capture({ transactionId: d.processorReference, amount: d.amount }); return { success: r.status === 'captured', status: r.status, capturedTotal: r.amount ?? d.amount ?? null, raw: r }; },
  async cancel(d)  { const r = await low.void({ transactionId: d.processorReference }); return { success: r.status === 'voided', status: r.status, raw: r }; },
  async refund(d)  { const r = await low.refund({ transactionId: d.processorReference, amount: d.amount }); return { success: r.status === 'refunded', status: r.status, refundedTotal: r.amount ?? d.amount ?? null, raw: r }; },
  mapStatus: (raw) => ({ approved: 'authorized', captured: 'captured', voided: 'cancelled', refunded: 'refunded' })[String(raw || '').toLowerCase()] || null,
  normalizeError: (raw) => makeError('unknown', typeof raw === 'string' ? raw : 'simulated error'),
});
