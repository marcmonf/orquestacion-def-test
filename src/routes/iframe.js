'use strict';

// src/routes/iframe.js
// Ruta del iFrame con validación HMAC, expiración y control de múltiples accesos.
// Cualquier error redirige SIEMPRE a /403.html (branding unificado).

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const Transaction = require('../models/Transaction'); // Mongoose model

const router = express.Router();

// =====================
// Configuración
// =====================
const HMAC_ALGO = 'sha256';
const IFRAME_HMAC_SECRET = process.env.IFRAME_HMAC_SECRET; // Debe estar definido en entorno
const REDIRECT_403_PATH = '/403.html'; // Ruta pública del HTML con branding
const IFRAME_HTML_ABS_PATH = path.join(process.cwd(), 'public', 'iframe.html'); // Ruta del iFrame real (estático)

// =====================
// Helpers
// =====================

/**
 * Redirige a 403.html con branding, pasando code y msg como querystring.
 * @param {express.Response} res
 * @param {string} code - Código corto de error (p.ej. 'expired', 'invalid_signature', 'already_processed')
 * @param {string} msg  - Mensaje legible (opcional; se puede usar o ignorar en 403.html)
 */
function redirectBranded403(res, code, msg) {
  try {
    const host = res.req.headers.host || 'localhost';
    const url = new URL(REDIRECT_403_PATH, `http://${host}`);
    if (code) url.searchParams.set('code', code);
    if (msg) url.searchParams.set('msg', msg);
    return res.redirect(302, url.pathname + (url.search || ''));
  } catch {
    // Fallback ultra defensivo
    return res.redirect(302, REDIRECT_403_PATH);
  }
}

/**
 * Verifica la firma HMAC recibida.
 * @param {object} params - Objeto con los parámetros que fueron firmados.
 * @param {string} signature - Firma recibida en la query.
 * @returns {boolean}
 */
function verifySignature(params, signature) {
  if (!IFRAME_HMAC_SECRET) return false;

  // Construcción canónica: AJUSTA el orden a tu convención real de firmado.
  const canon = [
    params.merchantId ?? '',
    params.paymentId ?? '',
    params.amount ?? '',
    params.currency ?? '',
    params.exp ?? '', // epoch seconds
  ].join('|');

  const hmac = crypto.createHmac(HMAC_ALGO, IFRAME_HMAC_SECRET).update(canon).digest('hex');

  try {
    // Comparación en tiempo constante
    return crypto.timingSafeEqual(Buffer.from(hmac, 'utf8'), Buffer.from(String(signature), 'utf8'));
  } catch {
    return false;
  }
}

/**
 * Comprueba expiración basada en epoch seconds (exp).
 * @param {string|number} exp
 * @returns {boolean} true si está expirada
 */
function isExpired(exp) {
  const now = Math.floor(Date.now() / 1000);
  const expNum = Number(exp);
  if (!Number.isFinite(expNum)) return true;
  return now > expNum;
}

// =====================
// GET /iframe/:paymentId
// =====================

router.get('/iframe/:paymentId', async (req, res) => {
  const { paymentId } = req.params;
  const {
    signature, // firma HMAC hex
    merchantId,
    amount,
    currency,
    exp, // epoch seconds
  } = req.query;

  // 1) Validaciones básicas de parámetros
  if (!paymentId || !signature || !merchantId || !amount || !currency || !exp) {
    return redirectBranded403(res, 'missing_params', 'Faltan parámetros obligatorios para cargar el iFrame.');
  }

  // 2) Verificar expiración
  if (isExpired(exp)) {
    // Log de intento con token caducado
    try {
      await Transaction.updateOne(
        { _id: paymentId },
        {
          $push: {
            events: {
              type: 'iframe_load_failed',
              reason: 'expired',
              at: new Date(),
              meta: { merchantId, amount, currency, exp },
            },
          },
        }
      );
    } catch (_) {}
    return redirectBranded403(res, 'expired', 'La sesión de pago ha expirado. Por favor, inicia de nuevo el proceso.');
  }

  // 3) Verificar firma
  const paramsForSign = { merchantId, paymentId, amount, currency, exp };
  const ok = verifySignature(paramsForSign, signature);
  if (!ok) {
    try {
      await Transaction.updateOne(
        { _id: paymentId },
        {
          $push: {
            events: {
              type: 'iframe_load_failed',
              reason: 'invalid_signature',
              at: new Date(),
              meta: { merchantId, amount, currency },
            },
          },
        }
      );
    } catch (_) {}
    return redirectBranded403(res, 'invalid_signature', 'No hemos podido validar la firma de seguridad.');
  }

  // 4) Buscar transacción y validar estado
  let tx;
  try {
    tx = await Transaction.findById(paymentId).lean();
  } catch (e) {
    return redirectBranded403(res, 'not_found', 'No se ha encontrado la transacción solicitada.');
  }

  if (!tx) {
    return redirectBranded403(res, 'not_found', 'No se ha encontrado la transacción solicitada.');
  }

  // Solo servimos el iFrame si la transacción está "initialized"
  if (tx.status !== 'initialized') {
    // Si ya está aprobada, denegada o en otro estado, bloqueamos recarga / reenvío
    try {
      await Transaction.updateOne(
        { _id: paymentId },
        {
          $push: {
            events: {
              type: 'iframe_load_blocked',
              reason: 'already_processed',
              at: new Date(),
              meta: { currentStatus: tx.status },
            },
          },
        }
      );
    } catch (_) {}
    return redirectBranded403(
      res,
      'already_processed',
      'Este pago ya ha sido procesado y no puede volver a cargarse.'
    );
  }

  // 5) Registrar trazabilidad de servicio del iFrame (no bloqueante)
  try {
    await Transaction.updateOne(
      { _id: paymentId },
      {
        $set: { iframeServedAt: new Date() },
        $push: {
          events: {
            type: 'iframe_served',
            at: new Date(),
            meta: { merchantId, amount, currency },
          },
        },
      }
    );
  } catch (_) {}

  // 6) Entregar el iFrame real tras pasar todas las validaciones
  return res.sendFile(IFRAME_HTML_ABS_PATH);
});

module.exports = router;
