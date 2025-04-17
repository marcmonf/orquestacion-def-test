const WebhookEvent = require('../models/WebhookEvent');

const getAllWebhooks = async (req, res) => {
  try {
    const events = await WebhookEvent.find().sort({ timestamp: -1 });
    res.status(200).json(events);
  } catch (error) {
    console.error('Error al obtener webhooks:', error);
    res.status(500).json({ error: 'Error al obtener eventos de webhook' });
  }
};

module.exports = { getAllWebhooks };
