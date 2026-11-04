// src/services/connectorHealth.js
'use strict';
//
// SALUD POR CONECTOR — circuit breaker (framework multi-PSP, nov 2026).
//
// Para qué sirve: que el routing deje de mandar checkouts NUEVOS a un PSP que
// está fallando (5xx, red, timeouts, credenciales rotas) y use el siguiente de
// la política, ANTES de pedir la tarjeta al comprador.
//
// Para qué NO sirve (invariante 5): jamás reintenta un cobro en otro PSP. Un
// pago que ya ha llegado a un PSP termina en ese PSP, salga bien, mal o con
// timeout.
//
// Qué cuenta como fallo: solo errores TÉCNICOS (errors.js →
// countsAsTechnicalFailure). Un rechazo del banco no es culpa del PSP.
//
// Estados: closed (sano) → open (tras N fallos técnicos seguidos dentro de la
// ventana) → half_open (pasado el enfriamiento, deja pasar tráfico de prueba:
// un éxito lo cierra, un fallo lo vuelve a abrir).
//
// En memoria, por proceso (Render hoy = una instancia). Con varias instancias
// cada una aprende por su cuenta: aceptable para un breaker.
//
// Ajustes: CB_FAILURE_THRESHOLD (5), CB_WINDOW_MS (60000), CB_COOLDOWN_MS (30000).

const { ERROR_CODES } = require('../connectors/errors');

const state = new Map(); // id → { failures:[ts], openedAt, status }
// Registro de fallos técnicos de los últimos 15 min por conector, para la
// alerta de "pico de errores del adquirente" (alertService). Independiente del
// breaker (que se vacía con un éxito).
const ERROR_LOG_MS = 15 * 60 * 1000;
const errorLog = new Map(); // id → [ts]

function cfg() {
  const num = (k, d) => { const v = parseInt(process.env[k] || '', 10); return Number.isFinite(v) && v > 0 ? v : d; };
  return { threshold: num('CB_FAILURE_THRESHOLD', 5), windowMs: num('CB_WINDOW_MS', 60000), cooldownMs: num('CB_COOLDOWN_MS', 30000) };
}

function entry(id) {
  if (!state.has(id)) state.set(id, { failures: [], openedAt: null, status: 'closed', lastError: null, lastSuccessAt: null });
  return state.get(id);
}

function statusOf(id, now = Date.now()) {
  const e = entry(id);
  if (e.status === 'open' && now - e.openedAt >= cfg().cooldownMs) e.status = 'half_open';
  return e.status;
}

function isTechnical(errorCode) {
  const def = ERROR_CODES[errorCode];
  return def ? def.countsAsTechnicalFailure : true;
}

function recordSuccess(id) {
  const e = entry(id);
  e.failures = []; e.status = 'closed'; e.openedAt = null; e.lastSuccessAt = new Date().toISOString();
}

function recordFailure(id, errorCode, now = Date.now()) {
  if (!isTechnical(errorCode)) return;  // rechazos del banco no cuentan
  const e = entry(id);
  const { threshold, windowMs } = cfg();
  e.lastError = { code: errorCode || 'unknown', at: new Date(now).toISOString() };
  const log = (errorLog.get(id) || []).filter((t) => now - t < ERROR_LOG_MS);
  log.push(now);
  errorLog.set(id, log);
  if (statusOf(id, now) === 'half_open') { e.status = 'open'; e.openedAt = now; return; }
  e.failures = e.failures.filter((t) => now - t < windowMs);
  e.failures.push(now);
  if (e.failures.length >= threshold) { e.status = 'open'; e.openedAt = now; }
}

// Registra el resultado de una llamada normalizada por el contrato.
function recordResult(id, result) {
  if (!result) return;
  if (result.status === 'error' || result.success === false) {
    const code = (result.error && result.error.code) || (result.errorInfo && result.errorInfo.code) || 'unknown';
    recordFailure(id, code);
  } else {
    recordSuccess(id);
  }
}

function isAvailable(id) { return statusOf(id) !== 'open'; }

function snapshot() {
  const out = {};
  for (const id of state.keys()) {
    const e = entry(id);
    out[id] = { status: statusOf(id), recentFailures: e.failures.length, lastError: e.lastError, lastSuccessAt: e.lastSuccessAt };
  }
  return out;
}

// Fallos técnicos de un conector en los últimos `ms` (máx. 15 min).
function recentTechnicalErrors(id, ms = ERROR_LOG_MS, now = Date.now()) {
  return (errorLog.get(id) || []).filter((t) => now - t < Math.min(ms, ERROR_LOG_MS)).length;
}

function knownConnectors() { return [...new Set([...state.keys(), ...errorLog.keys()])]; }

function _reset() { state.clear(); errorLog.clear(); }

module.exports = { isAvailable, statusOf, recordSuccess, recordFailure, recordResult, snapshot, recentTechnicalErrors, knownConnectors, _reset };
