'use strict';

const express = require('express');
const crypto = require('crypto');
const Transaction = require('../models/Transaction');

const router = express.Router();

// ============================
// Config
// ============================
const IFRAME_TTL_SECONDS = Number(process.env.IFRAME_TTL_SECONDS || 60); // 60s por defecto
const HMAC_SECRET = process.env.IFRAME_HMAC_SECRET || '';

// ============================
// Helpers
// ============================
function buildBaseUrl(req) {
  // Respeta Render / proxies
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}`;
}

function hmacSha256Hex(input, secret) {
  return crypto.createHmac('sha256', secret).update(input).digest('hex');
}

function randomHex32() {
  return crypto.randomBytes(32).toString('hex');
}

// ============================
// POST /initialize
// ============================
router.post('/', async (req, res, next) => {
  try {
    const { merchantId, amount, currency, method, returnUrl, callbackUrl } = req.body || {};

    // Validación mínima (igual que antes: simple y directa)
    if (!merchantId || amount == null || !currency || !method) {
      return res.status(400).json({ success: false, message: 'Parámetros obligatorios faltantes.' });
    }

    // Generar paymentId (UUID nativo de Node 18+)
    const paymentId = crypto.randomUUID();

    const now = new Date();
    const expiresAt = new Date(now.getTime() + IFRAME_TTL_SECONDS * 1000);
    const expIso = expiresAt.toISOString();

    // Firma: canónico = paymentId|exp(ISO)
    // - Si hay HMAC secreto, firmamos con HMAC-SHA256.
    // - Si no hay, usamos una firma aleatoria (válida en DEV, evita romper flujo).
    //   TODO: Define IFRAME_HMAC_SECRET en producción para máxima seguridad.
    const canonical = `${paymentId}|${expIso}`;
    const signature = HMAC_SECRET ? hmacSha256Hex(canonical, HMAC_SECRET) : randomHex32();

    // Persistir transacción (NO tocamos _id → Mongoose crea ObjectId; usamos campo paymentId:string)
    await Transaction.create({
      paymentId,               // UUID string
      merchantId,
      amount,
      currency,
      method,
      returnUrl,
      callbackUrl,
      status: 'initialized',
      signature,               // campo simple que el iFrame valida primero
      security: { signature }, // compat futura: también aquí
      expiresAt,               // fuente de verdad para expiración
      createdAt: now,
      events: [
        {
          type: 'initialized',
          at: now,
          meta: { from: 'initialize', version: 1 }
        }
      ]
    });

    // Construir iframeUrl (formato query params que ya usabas)
    const base = buildBaseUrl(req);
    const iframeUrl =
      `${base}/iframe-process?` +
      `paymentId=${encodeURIComponent(paymentId)}` +
      `&signature=${encodeURIComponent(signature)}` +
      `&exp=${encodeURIComponent(expIso)}`;

    return res.status(200).json({
      success: true,
      paymentId,
      signature,
      timestamp: now.toISOString(),
      expiresAt: expIso,
      iframeUrl
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
