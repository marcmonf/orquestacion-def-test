'use strict';

const express = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const Transaction = require('../models/Transaction');

const router = express.Router();

// Config
const IFRAME_HMAC_SECRET = process.env.IFRAME_HMAC_SECRET || '';
const IFRAME_TTL_SECONDS = Number(process.env.IFRAME_TTL_SECONDS || 60); // como hasta ahora: ~60s

function hmacSha256Hex(input, secret) {
  return crypto.createHmac('sha256', secret).update(input).digest('hex');
}

function buildBaseUrl(req) {
  // usa el mismo host de la petición (Render: correcto para tu dominio público)
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}`;
}

/**
 * POST /initialize
 * Body:
 *  { merchantId, amount, currency, method, returnUrl, callbackUrl }
 *
 * Respuesta:
 *  { success, paymentId, signature, timestamp, expiresAt, iframeUrl }
 */
router.post('/', async (req, res, next) => {
  try {
    // 1) Validación básica
    const { merchantId, amount, currency, method, returnUrl, callbackUrl } = req.body || {};

    if (!merchantId || !amount || !currency || !method) {
      return res.status(400).json({ success: false, message: 'Parámetros obligatorios faltantes.' });
    }
    if (!IFRAME_HMAC_SECRET) {
      return res.status(500).json({ success: false, message: 'Configuración inválida de HMAC.' });
    }

    // 2) Generar paymentId (UUID string) y expiración
    const paymentId = uuidv4();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + IFRAME_TTL_SECONDS * 1000);

    // 3) Firma canónica (igual que venías devolviendo): paymentId|exp(ISO)
    const expIso = expiresAt.toISOString();
    const canonical = `${paymentId}|${expIso}`;
    const signature = hmacSha256Hex(canonical, IFRAME_HMAC_SECRET);

    // 4) Persistir transacción
    //    ⚠️ IMPORTANTE: NO usamos _id = paymentId (para evitar CastError a ObjectId).
    //    Guardamos el UUID en el campo paymentId (string) y dejamos _id como ObjectId por defecto.
    await Transaction.create({
      paymentId,                 // UUID string
      merchantId,
      amount,
      currency,
      method,
      returnUrl,
      callbackUrl,
      status: 'initialized',
      signature,                 // compat: muchos sitios leerán aquí
      security: { signature },   // compat futura
      expiresAt,                 // fuente de verdad para iFrame
      createdAt: now,
      events: [
        {
          type: 'initialized',
          at: now,
          meta: { from: 'initialize', version: 1 }
        }
      ]
    });

    // 5) Construir iframeUrl (formato que ya usas: query params)
    const base = buildBaseUrl(req);
    const iframeUrl = `${base}/iframe-process?` +
      `paymentId=${encodeURIComponent(paymentId)}` +
      `&signature=${encodeURIComponent(signature)}` +
      `&exp=${encodeURIComponent(expIso)}`;

    // 6) Responder
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
