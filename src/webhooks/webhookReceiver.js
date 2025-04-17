const express = require('express');
const router = express.Router();
const Joi = require('joi');

// Esquema de validación
const webhookSchema = Joi.object({
  paymentId: Joi.string().required(),
  status: Joi.string().required(),
  authCode: Joi.string().required(),
  processor: Joi.string().required(),
  timestamp: Joi.date().iso().required()
});

router.post('/', (req, res) => {
  const { error } = webhookSchema.validate(req.body);

  if (error) {
    return res.status(400).json({ error: 'Datos de webhook inválidos' });
  }

  console.log('Webhook recibido:', req.body);
  res.status(200).json({ message: 'Webhook recibido correctamente' });
});

module.exports = router;
