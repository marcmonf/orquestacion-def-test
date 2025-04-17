const express = require('express');
const router = express.Router();
const Joi = require('joi');
const WebhookEvent = require('../models/WebhookEvent');

// Esquema de validación
const webhookSchema = Joi.object({
  paymentId: Joi.string().required(),
  status: Joi.string().required(),
  authCode: Joi.string().required(),
  processor: Joi.string().required(),
  timestamp: Joi.date().iso().required()
});

router.post('/', async (req, res) => {
  const { error } = webhookSchema.validate(req.body);

  if (error) {
    return res.status(400).json({ error: 'Datos de webhook inválidos' });
  }

  try {
    // Guardar el evento en MongoDB
    const event = new WebhookEvent(req.body);
    await event.save();

    console.log('Webhook recibido y guardado:', req.body);
    res.status(200).json({ message: 'Webhook recibido y almacenado correctamente' });
  } catch (err) {
    console.error('Error al guardar el webhook:', err);
    res.status(500).json({ error: 'Error interno al guardar el webhook' });
  }
});

module.exports = router;
