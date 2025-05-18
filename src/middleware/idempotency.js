// src/middleware/idempotency.js
const IdempotencyRecord = require('../models/IdempotencyRecord');

const idempotencyMiddleware = async (req, res, next) => {
  try {
    const key = req.headers['idempotency-key'];

    if (!key) {
      return next(); // Si no se envía la clave, no se aplica idempotencia
    }

    const existingRecord = await IdempotencyRecord.findOne({
      idempotencyKey: key,
      method: req.method,
      endpoint: req.originalUrl
    });

    if (existingRecord) {
      return res.status(existingRecord.statusCode).json(existingRecord.responseBody);
    }

    // Redefinimos res.json para capturar la respuesta real
    const originalJson = res.json.bind(res);

    res.json = async (body) => {
      try {
        const newRecord = new IdempotencyRecord({
          idempotencyKey: key,
          method: req.method,
          endpoint: req.originalUrl,
          requestBody: req.body,
          responseBody: body,
          statusCode: res.statusCode
        });

        await newRecord.save();
      } catch (err) {
        console.error('Error guardando respuesta idempotente:', err.message);
      }

      return originalJson(body);
    };

    next();
  } catch (err) {
    console.error('Error en middleware de idempotencia:', err.message);
    return res.status(500).json({ success: false, message: 'Error procesando clave de idempotencia.' });
  }
};

module.exports = idempotencyMiddleware;
