'use strict';
const mongoose = require('mongoose');

// Cola PERSISTENTE de webhooks salientes al merchant (ver webhookDispatcher.js).
// Cada documento es una entrega: se reintenta hasta deliveredAt o failedAt.
const schema = new mongoose.Schema({
  paymentId:   { type: String, required: true },
  merchantId:  { type: String, required: true },
  url:         { type: String,  required: true },
  payload:     { type: Object,  required: true },

  attempt:       { type: Number, default: 0 },
  lastStatus:    { type: Number, default: null },
  lastError:     { type: String, default: null },
  deliveredAt:   { type: Date,   default: null },
  failedAt:      { type: Date,   default: null },   // reintentos agotados
  nextAttemptAt: { type: Date,   default: Date.now },
  lockedUntil:   { type: Date,   default: null },   // reclamado por un proceso

  createdAt:   { type: Date, default: Date.now },
  updatedAt:   { type: Date, default: Date.now }
});

schema.index({ merchantId: 1, createdAt: -1 });
schema.index({ paymentId: 1 });
schema.index({ deliveredAt: 1 });
schema.index({ deliveredAt: 1, failedAt: 1, nextAttemptAt: 1 });

module.exports = mongoose.models.WebhookLog ||
  mongoose.model('WebhookLog', schema);
