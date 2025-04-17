const express = require('express');
const router = express.Router();
const Joi = require('joi');
const WebhookEvent = require('../models/WebhookEvent'); // Importa el modelo

// Esquema de validación
const webhookSchema = Joi.object({
  paymentId: Joi.string().required(),
  status: Joi.string().required(),
  authCode: Joi.string().required(),
  processor: Joi.string().required(),
  timestamp: Joi.date().iso().required()
});

// Ruta para recibir webhooks
router.post('/', async (req, res) => {
  const { error } = webhookSchema.validate(req.body);

  if (error) {
    return res.status(400).json({ error: 'Datos de webhook inválidos' });
  }

  try {
    await WebhookEvent.create(req.body); // Guarda el evento en MongoDB
    console.log('Webhook recibido y almacenado:', req.body);
    res.status(200).json({ message: 'Webhook recibido correctamente' });
  } catch (err) {
    console.error('Error al guardar el webhook:', err);
    res.status(500).json({ error: 'Error al almacenar el webhook' });
  }
});

module.exports = router;
