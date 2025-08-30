// src/channels/apms/apmsHandler.js
const express = require('express');
const router = express.Router();
const transactionManager = require('../../core/transactionManager');
const Token = require('../../models/Token');
const paymentSchema = require('../../validators/paymentValidator');

// Auth opcional por ENV (no romper clientes que aún no pasan x-api-key)
let apiKeyAuth = (req, res, next) => next();
if (String(process.env.APMS_REQUIRE_API_KEY).toLowerCase() === 'true') {
  try { apiKeyAuth = require('../../middleware/auth'); } catch { /* opcional */ }
}

router.post('/payments', apiKeyAuth, async (req, res) => {
  try {
    const tx = { ...req.body };

    // Validar payload
    const { error } = paymentSchema.validate(tx);
    if (error) return res.status(400).json({ error: error.details[0].message });

    // Si viene token, buscar datos asociados
    if (tx.token) {
      const tokenData = await Token.findOne({ token: tx.token });
      if (!tokenData) return res.status(404).json({ error: 'Token no encontrado' });

      // ⚠️ Mantener compat actual: usar pan/expiry del token almacenado.
      // Recomendación futura: resolver mediante servicio con cifrado GCM y sin reversibilidad operativa.
      tx.cardNumber = tokenData.pan;
      tx.expiry     = tokenData.expiry;
    }

    tx.channel = 'apms';
    const result = await transactionManager.process(tx);
    return res.status(200).json(result);

  } catch (error) {
    console.error('Error en APM handler:', error);
    return res.status(500).json({ error: 'Error interno en el procesamiento' });
  }
});

module.exports = router;
