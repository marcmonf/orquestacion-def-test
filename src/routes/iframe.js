'use strict';

// src/routes/iframe.js
// Carga segura del iFrame con validación HMAC, expiración, control de múltiples accesos
// y SERVIDO DE PÁGINAS DE ERROR ESPECÍFICAS (cada una con su HTML propio y branding).
//
// No modifica ningún HTML. Sólo decide qué archivo servir según el error.

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
// Usamos __dirname relativo a /src/routes → subimos dos niveles a /
const PUBLIC_DIR = path.resolve(__dirname, '../../public'); // carpeta con los HTML estáticos
const IFRAME_HTML_ABS_PATH = path.join(PUBLIC_DIR, 'iframe.html'); // iFrame real

// Mapa de páginas de error (ajusta a los nombres reales de tus HTML si difieren)
const ERROR_PAGE_MAP = {
  missing_params:   { file: '400.html', status: 400 }, // parámetros incompletos
  expired:          { file: '410.html', status: 410 }, // sesión expirada
  invalid_signature:{ file: '422.html', status: 422 }, // firma inválida / unprocessable
  not_found:        { file: '404.html', status: 404 }, // transacción no encontrada
  already_processed:{ file: '409.html', status: 409 }, // reintento sobre pago ya procesado
  default:          { file: '403.html', status: 403 }, // fallback de seguridad / acceso denegado
};

// =====================
// Helpers
// =====================

/**
 * Sirve el HTML de error con branding específico.
 * No redirige: entrega directamente el archivo estático correspondiente.
 * Si el archivo específico no existe, sirve el fallback 403.
 * @param {express.Response} res
 * @param {keyof ERROR_PAGE_MAP} code
 */
function serveBrandedError(res, code) {
  const entry = ERROR_PAGE_MAP[code] || ERROR_PAGE_MAP.default;
  const absPath = path.join(PUBLIC_DIR, entry.file);
  res.status(entry.status);
  res.sendFile(absPath, (err) => {
    if (err) {
      // Fallback ultra defensivo a 403 si el archivo mapeado no existe o falla el envío
      const fb = ERROR_PAGE_MAP.default;
      res.status(fb.status).sendFile(path.join(PUBLIC_DIR, fb.file));
    }
  });
}

/**
 * Construye la firma esperada y compara en tiempo constante.
 * Ajusta el orden del canónico si tu /initialize firma en otro orden.
 */
function verifySignature(params, signature) {
  if (!IFRAME_HMAC_SECRET) return false;

  // Orden canónico propuesto: merchantId|paymentId|amount|currency|exp
  const canon = [
    params.merchantId ?? '',
    params.paymentId ?? '',
    params.amount ?? '',
    params.currency ?? '',
    params.exp ?? '', // epoch seconds
  ].join('|');

  const h = crypto.createHmac(HMAC_ALGO, IFRAME_HMAC_SECRET).update(canon).digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(h, 'utf8'),
      Buffer.from(String(signature || ''), 'utf8')
    );
  } catch {
    return false;
  }
}

/** Devuelve true si exp (epoch seconds) está caducado. */
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
    signature, // HMAC hex
    merchantId,
    amount,
    currency,
    exp, // epoch seconds
  } = req.query;

  // 1) Validaciones básicas
  if (!paymentId || !signature || !merchantId || !amount || !currency || !exp) {
    return serveBrandedError(res, 'missing_params');
  }

  // 2) Expiración
  if (isExpired(exp)) {
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
    return serveBrandedError(res, 'expired');
  }

  // 3) Firma
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
    return serveBrandedError(res, 'invalid_signature');
  }

  // 4) Transacción y estado
  let tx;
  try {
    tx = await Transaction.findById(paymentId).lean();
  } catch {
    return serveBrandedError(res, 'not_found');
  }

  if (!tx) {
    return serveBrandedError(res, 'not_found');
  }

  if (tx.status !== 'initialized') {
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
    return serveBrandedError(res, 'already_processed');
  }

  // 5) Trazabilidad de servicio del iFrame (no bloqueante)
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

  // 6) Entregar el iFrame real tras pasar validaciones
  return res.sendFile(IFRAME_HTML_ABS_PATH, (err) => {
    if (err) {
      // Si por cualquier motivo no se puede servir el iframe, devolvemos 403 branded
      serveBrandedError(res, 'default');
    }
  });
});

module.exports = router;
