const express = require('express');
const router = express.Router();
const transactionManager = require('../../core/transactionManager');
const Token = require('../../models/Token');
const paymentSchema = require('../../validators/paymentValidator');

router.post('/payments', async (req, res) => {
  try {
    const tx = req.body;

    // Validar payload
    const { error } = paymentSchema.validate(tx);
    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }

    // Si viene token, buscar los datos reales
    if (tx.token) {
      const tokenData = await Token.findOne({ token: tx.token });
      if (!tokenData) {
        return res.status(404).json({ error: 'Token no encontrado' });
      }
      tx.cardNumber = tokenData.pan;
      tx.expiry = tokenData.expiry;
    }

    tx.channel = 'apms';
    const result = await transactionManager.process(tx);
    return res.status(200).json(result);

  } catch (error) {
    console.error("Error en APM handler:", error);
    return res.status(500).json({ error: "Error interno en el procesamiento" });
  }
});

module.exports = router;
