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

// POST /webhooks - Recibe y guarda eventos
router.post('/', async (req, res) => {
  const { error } = webhookSchema.validate(req.body);

  if (error) {
    return res.status(400).json({ error: 'Datos de webhook inválidos' });
  }

  try {
    const event = new WebhookEvent(req.body);
    await event.save();

    console.log('Webhook recibido y guardado:', req.body);
    res.status(200).json({ message: 'Webhook recibido y almacenado correctamente' });
  } catch (err) {
    console.error('Error al guardar el webhook:', err);
    res.status(500).json({ error: 'Error interno al guardar el webhook' });
  }
});

// GET /webhooks - Lista todos los eventos guardados
router.get('/', async (req, res) => {
  try {
    const events = await WebhookEvent.find().sort({ timestamp: -1 });
    res.status(200).json(events);
  } catch (err) {
    console.error('Error al obtener los webhooks:', err);
    res.status(500).json({ error: 'Error al recuperar los eventos de webhook' });
  }
});

module.exports = router;
