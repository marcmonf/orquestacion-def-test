'use strict';
const mongoose = require('mongoose');

const WebhookLogSchema = new mongoose.Schema({
  paymentId: { type: String, index: true },
  merchantId: { type: String, index: true },
  url: { type: String, required: true },
  method: { type: String, default: 'POST' },
  headers: { type: Object, default: {} },
  payload: { type: Object, required: true },

  attempt: { type: Number, default: 0 },
  maxRetries: { type: Number, default: 6 },
  backoffBaseMs: { type: Number, default: 1000 },

  lastStatus: { type: Number },
  lastError: { type: String },

  nextAttemptAt: { type: Date },
  deliveredAt: { type: Date },

  createdAt: { type: Date, default: Date.now }
}, { collection: 'WebhookLog' });

module.exports = mongoose.models.WebhookLog ||
  mongoose.model('WebhookLog', WebhookLogSchema);
