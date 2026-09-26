// src/utils/checkoutResult.js
'use strict';
//
// PÁGINA DE RESULTADO del checkout (/checkout/result/:paymentId).
//
// Paylands redirige al comprador a `url_ok` / `url_ko` al terminar el pago
// (3DS incluido) — parámetros documentados de POST /payment. Antes no se
// enviaban: tras el 3DS el comprador se quedaba en una página de Paylands
// dentro del iFrame y ni él ni la web del comercio sabían qué había pasado.
//
// Las URLs van FIRMADAS con el secreto de plataforma (utils/hppSigner) y
// CADUCAN: nadie puede consultar el estado de un pago cambiando el paymentId,
// ni alterar el "ok"/"ko" de la URL, ni reutilizar el enlace indefinidamente.
//
// Dos firmas distintas (campo `purpose`), para que una no sirva por la otra:
//   - la de la página   (checkout_result): paymentId + outcome + exp — 24 h
//   - la de la consulta de estado que hace la página (checkout_status): 1 h
//
// El resultado que se enseña y se comunica SIEMPRE sale del estado guardado en
// la transacción (lo actualiza el webhook de Paylands), nunca del "ok"/"ko" de
// la URL: eso es solo lo que dijo la redirección.

const hppSigner = require('./hppSigner');
const { SUCCESSFUL_STATUSES, FAILED_STATUSES } = require('./paymentStatus');

const RESULT_TTL_MS = 24 * 60 * 60 * 1000;
const STATUS_TTL_MS = 60 * 60 * 1000;

function baseUrl() {
  const raw = process.env.HPP_BASE_URL || process.env.SERVER_URL || 'https://orquestacion-def-test.onrender.com';
  return String(raw).replace(/\/+$/, '');
}

function normOutcome(outcome) {
  return outcome === 'ko' ? 'ko' : 'ok';
}

function pageSignature(paymentId, outcome, exp) {
  return hppSigner.sign({
    purpose: 'checkout_result',
    paymentId: String(paymentId),
    outcome: normOutcome(outcome),
    exp: String(exp),
  });
}

function statusSignature(paymentId, exp) {
  return hppSigner.sign({
    purpose: 'checkout_status',
    paymentId: String(paymentId),
    exp: String(exp),
  });
}

// ── Construcción de URLs ─────────────────────────────────────────────────────
// `sig` va SIEMPRE el último: si la pasarela añadiese sus propios parámetros
// pegando "?x=y" al final (sin "&"), solo se ensucia `sig`, y el lector de
// abajo se queda con sus 64 caracteres hex.
function resultPath(paymentId, outcome, now = Date.now()) {
  const o = normOutcome(outcome);
  const exp = now + RESULT_TTL_MS;
  return `/checkout/result/${encodeURIComponent(String(paymentId))}` +
    `?outcome=${o}&exp=${exp}&sig=${pageSignature(paymentId, o, exp)}`;
}

function resultUrl(paymentId, outcome, now = Date.now()) {
  return `${baseUrl()}${resultPath(paymentId, outcome, now)}`;
}

function statusPath(paymentId, now = Date.now()) {
  const exp = now + STATUS_TTL_MS;
  return `/checkout/result/${encodeURIComponent(String(paymentId))}/status` +
    `?exp=${exp}&sig=${statusSignature(paymentId, exp)}`;
}

// ── Lectura tolerante de la query ────────────────────────────────────────────
function first(value) {
  return Array.isArray(value) ? value[value.length - 1] : value;
}

function parseQuery(query) {
  const q = query || {};
  const o = /^(ok|ko)/.exec(String(first(q.outcome) || ''));
  const e = /^\d{10,16}/.exec(String(first(q.exp) || ''));
  const s = /^[0-9a-f]{64}/i.exec(String(first(q.sig) || ''));
  return {
    outcome: o ? o[1] : null,
    exp: e ? Number(e[0]) : null,
    sig: s ? s[0].toLowerCase() : null,
  };
}

// Resultado: { ok: true, outcome } | { ok: false, reason: 'invalid' | 'expired' }.
// La firma se comprueba ANTES que la caducidad: un enlace falso es 'invalid'
// aunque además esté caducado.
function verifyPage(paymentId, query, now = Date.now()) {
  const { outcome, exp, sig } = parseQuery(query);
  if (!paymentId || !outcome || !exp || !sig) return { ok: false, reason: 'invalid' };
  if (!hppSigner.verify({
    purpose: 'checkout_result', paymentId: String(paymentId), outcome, exp: String(exp),
  }, sig)) return { ok: false, reason: 'invalid' };
  if (now > exp) return { ok: false, reason: 'expired' };
  return { ok: true, outcome };
}

function verifyStatus(paymentId, query, now = Date.now()) {
  const { exp, sig } = parseQuery(query);
  if (!paymentId || !exp || !sig) return { ok: false, reason: 'invalid' };
  if (!hppSigner.verify({
    purpose: 'checkout_status', paymentId: String(paymentId), exp: String(exp),
  }, sig)) return { ok: false, reason: 'invalid' };
  if (now > exp) return { ok: false, reason: 'expired' };
  return { ok: true };
}

// ── Resultado para el comprador y para la web del comercio ──────────────────
// 'succeeded' | 'failed' | 'pending'. 'error' cuenta como fallido: en el flujo
// del checkout, si la creación de la orden falla, el comprador nunca recibe el
// enlace del 3DS y el pago no puede llegar a autorizarse.
const CLOSED_WITHOUT_PAYMENT = ['cancelled', 'canceled'];

function resultOf(status) {
  if (SUCCESSFUL_STATUSES.includes(status)) return 'succeeded';
  if (FAILED_STATUSES.includes(status) || CLOSED_WITHOUT_PAYMENT.includes(status)) return 'failed';
  return 'pending';
}

// returnUrl del merchant: solo http(s) y sin credenciales (se valida al crear
// el pago; aquí se vuelve a comprobar porque se usa para navegar).
function parseHttpUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null;
  return u;
}

// Vuelta a la tienda: la returnUrl del merchant + paymentId + result. El
// `result` es informativo: el merchant confirma con el webhook o GET status.
function buildReturnUrl(raw, paymentId, result) {
  const u = parseHttpUrl(raw);
  if (!u) return null;
  u.searchParams.set('paymentId', String(paymentId));
  u.searchParams.set('result', result);
  return u.toString();
}

module.exports = {
  resultPath,
  resultUrl,
  statusPath,
  verifyPage,
  verifyStatus,
  resultOf,
  buildReturnUrl,
  RESULT_TTL_MS,
  STATUS_TTL_MS,
  _test: { parseQuery, pageSignature, statusSignature },
};
