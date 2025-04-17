const express = require('express');
const router = express.Router();
const WebhookEvent = require('../models/WebhookEvent');

// GET /webhooks con filtros opcionales
router.get('/', async (req, res) => {
  try {
    const { status, paymentId, from, to } = req.query;

    const filters = {};

    if (status) filters.status = status;
    if (paymentId) filters.paymentId = paymentId;
    if (from || to) {
      filters.timestamp = {};
      if (from) filters.timestamp.$gte = new Date(from);
      if (to) filters.timestamp.$lte = new Date(to);
    }

    const results = await WebhookEvent.find(filters).sort({ timestamp: -1 });
    res.status(200).json(results);
  } catch (err) {
    console.error('Error al filtrar webhooks:', err);
    res.status(500).json({ error: 'Error interno al obtener webhooks' });
  }
});

module.exports = router;
