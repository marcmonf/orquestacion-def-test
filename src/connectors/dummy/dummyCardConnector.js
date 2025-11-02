//src/connectors/dummy/dummyCardConnector.js

'use strict';
const { recordAttempt } = require('../../orchestrator/metrics/metricsService');

const ID = 'dummyCard';

/**
 * Simula una autorización de tarjeta.
 * No llama a ningún PSP real. Útil para flujos E2E sin riesgo.
 */
async function authorize({ amount, currency, merchantId, paymentId }) {
  const start = Date.now();
  // Simulación simple: siempre approve en <120ms
  await new Promise(r => setTimeout(r, 80));
  const latency = Date.now() - start;

  // registra métrica
  recordAttempt(ID, { ok: true, latencyMs: latency, costBps: 120 }); // coste simulado

  return {
    status: 'approved',
    processor: ID,
    transactionId: `dm_${paymentId || Math.random().toString(36).slice(2)}`,
    authCode: 'APPROVED',
    timestamp: new Date().toISOString()
  };
}

async function capture({ transactionId, amount }) {
  return { status: 'captured', processor: ID, transactionId, amount, timestamp: new Date().toISOString() };
}
async function voidOp({ transactionId }) {
  return { status: 'voided', processor: ID, transactionId, timestamp: new Date().toISOString() };
}
async function refund({ transactionId, amount }) {
  return { status: 'refunded', processor: ID, transactionId, amount, timestamp: new Date().toISOString() };
}

module.exports = { ID, authorize, capture, void: voidOp, refund };
