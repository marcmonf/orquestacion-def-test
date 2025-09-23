'use strict';

/**
 * Fallback/smart-retries SIMULADO para entorno de desarrollo.
 *
 * Objetivo: RESPONDER RÁPIDO SIEMPRE.
 * - Sin llamadas externas.
 * - Sin esperas largas.
 * - Determinismo por amount para forzar approved/declined si quieres probar.
 *
 * Config (ENV):
 *  - FAST_MODE=1              → fuerza tiempos ultra cortos (default: 1)
 *  - MAX_RETRIES=0..2         → nº de reintentos simulados (default: 0 en fast)
 *  - JITTER_MS="50,120"       → esperas entre intentos en ms (default: 50,120)
 *
 * Contrato de salida (se mantiene):
 *  {
 *    status: 'approved' | 'declined',
 *    processor: <string>,
 *    transactionId: <string>,
 *    authCode?: <string>,
 *    timestamp: <ISO string>,
 *    reasonCode?: <string>
 *  }
 */

const crypto = require('crypto');

const FAST_MODE   = String(process.env.FAST_MODE || '1') === '1';
const MAX_RETRIES = Number(process.env.MAX_RETRIES || (FAST_MODE ? 0 : 1));
const JITTER_ARR  = String(process.env.JITTER_MS || '50,120')
  .split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n) && n >= 0);

/** espera no bloqueante */
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function randId(prefix) {
  const rand = crypto.randomBytes(6).toString('hex');
  return `${prefix}_${Date.now()}_${rand}`;
}

/**
 * Simula una autorización de tarjeta para un "conector".
 * Nunca llama a redes. Tiempo total típico <100ms en FAST_MODE.
 */
async function execOnce({ connector, amount }) {
  // Regla simple para forzar outcomes en test:
  // - amount == 11 → approved
  // - amount == 12 → declined (soft_decline)
  // - amount == 13 → network_error (para probar fallback)
  let outcome = 'approved';
  let reason  = null;

  if (amount === 12) { outcome = 'declined'; reason = 'soft_decline'; }
  else if (amount === 13) { outcome = 'network_error'; reason = 'timeout'; }

  // mini jitter para no 0ms
  if (!FAST_MODE) await sleep(30);

  const base = {
    processor: connector || 'dummyCard',
    transactionId: randId('tx'),
    timestamp: new Date().toISOString()
  };

  if (outcome === 'approved') {
    return { ...base, status: 'approved', authCode: String(Math.floor(100000 + Math.random() * 899999)) };
  }
  if (outcome === 'declined') {
    return { ...base, status: 'declined', reasonCode: reason || 'declined' };
  }
  // network_error simulado → lanzar para activar retry
  const err = new Error('network_error');
  err.code = 'network_error';
  throw err;
}

/**
 * API utilizada por transactionController
 */
async function executeCardPayment({ paymentRequest, paymentId, primaryConnector }) {
  const connector = primaryConnector || 'dummyCard';
  const amount = Number(paymentRequest?.amount || 0);

  // intento 0
  try {
    return await execOnce({ connector, amount });
  } catch (e) {
    // solo si simulamos network_error
  }

  // reintentos rápidos controlados
  const retries = Math.max(0, Math.min(MAX_RETRIES, 2));
  for (let i = 0; i < retries; i++) {
    const wait = JITTER_ARR[i] ?? 80;
    await sleep(wait); // ms
    try {
      return await execOnce({ connector, amount });
    } catch (e) {
      // continuar
    }
  }

  // Si tras reintentos sigue mal, devolver declined controlado
  return {
    status: 'declined',
    processor: connector,
    transactionId: randId('tx'),
    timestamp: new Date().toISOString(),
    reasonCode: 'network_error_final'
  };
}

module.exports = { executeCardPayment };
