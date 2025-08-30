// src/middleware/idempotency.js
const crypto = require('crypto');
const IdempotencyKey = require('../models/IdempotencyKey');

function normalizeBody(body) {
  // Ordenar claves para hash estable
  return JSON.stringify(body, Object.keys(body).sort());
}

function hashRequest(path, body) {
  const h = crypto.createHash('sha256');
  h.update(path + '|' + normalizeBody(body || {}));
  return h.digest('hex');
}

module.exports = async function idempotency(req, res, next) {
  // Solo en POST que crean recursos (p.ej. /transactions)
  const key = req.get('Idempotency-Key');
  if (!key) return next();

  const bodyHash = hashRequest(req.path, req.body);
  const existing = await IdempotencyKey.findOne({ key });

  // Reintento idéntico
  if (existing && existing.bodyHash === bodyHash && existing.response) {
    return res.status(existing.response.statusCode || 200).json(existing.response.body);
  }

  // Conflicto si la clave existe pero el body cambió
  if (existing && existing.bodyHash !== bodyHash) {
    return res.status(409).json({
      success: false,
      message: 'Idempotency key conflict: different payload for same key.'
    });
  }

  // Marcar inicio
  await IdempotencyKey.create({
    key,
    bodyHash,
    response: null,
  });

  // Al responder, guardamos
  const originalJson = res.json.bind(res);
  res.json = async (payload) => {
    try {
      const statusCode = res.statusCode || 200;
      await IdempotencyKey.updateOne(
        { key },
        { $set: { response: { statusCode, body: payload } } }
      );
    } catch (_) { /* no-op */ }
    return originalJson(payload);
  };

  next();
};
