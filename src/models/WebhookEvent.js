const mongoose = require('mongoose');

const webhookEventSchema = new mongoose.Schema({
  paymentId: { type: String, required: true },
  status: { type: String, required: true },
  authCode: { type: String, required: true },
  processor: { type: String, required: true },
  timestamp: { type: Date, required: true },
}, { timestamps: true });

module.exports = mongoose.model('WebhookEvent', webhookEventSchema);
