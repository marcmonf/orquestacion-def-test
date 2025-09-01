'use strict';
const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, index: true },
  scope: { type: String, required: true }, // método+path+merchantId
  requestHash: { type: String, required: true },
  statusCode: { type: Number, required: true },
  responseBody: { type: Object, required: true },
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true, index: true }
}, { collection: 'IdempotencyKey' });

// TTL real gestionado por expiresAt + index
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.IdempotencyKey ||
  mongoose.model('IdempotencyKey', schema);
