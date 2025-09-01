'use strict';
const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  paymentId:   { type: String, required: true },
  merchantId:  { type: String, required: true },
  url:         { type: String,  required: true },
  payload:     { type: Object,  required: true },

  attempt:     { type: Number, default: 0 },
  lastStatus:  { type: Number, default: null },
  lastError:   { type: String, default: null },
  deliveredAt: { type: Date,   default: null },

  createdAt:   { type: Date, default: Date.now },
  updatedAt:   { type: Date, default: Date.now }
});

schema.index({ merchantId: 1, createdAt: -1 });
schema.index({ paymentId: 1 });
schema.index({ deliveredAt: 1 });

module.exports = mongoose.models.WebhookLog ||
  mongoose.model('WebhookLog', schema);
