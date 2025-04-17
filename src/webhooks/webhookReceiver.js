const express = require('express');
const router = express.Router();
const webhookSchema = require('../validators/webhookValidator');

router.post('/', async (req, res) => {
  const { error } = webhookSchema.validate(req.body);
  
  if (error) {
    console.error("Payload de webhook inválido:", error.details);
    return res.status(400).json({ error: "Datos de webhook inválidos" });
  }

  // Aquí procesaríamos el webhook (puedes ampliarlo más adelante)
  console.log("Webhook recibido y válido:", req.body);

  return res.status(200).json({ message: "Webhook recibido correctamente" });
});

module.exports = router;
