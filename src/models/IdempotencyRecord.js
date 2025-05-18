// src/models/IdempotencyRecord.js
const mongoose = require('mongoose');

const IdempotencyRecordSchema = new mongoose.Schema({
  idempotencyKey: {
    type: String,
    required: true,
    unique: true
  },
  method: {
    type: String,
    required: true
  },
  endpoint: {
    type: String,
    required: true
  },
  requestBody: {
    type: Object,
    required: true
  },
  responseBody: {
    type: Object,
    required: true
  },
  statusCode: {
    type: Number,
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now,
    expires: 86400 // TTL opcional: elimina después de 24h
  }
});

module.exports = mongoose.model('IdempotencyRecord', IdempotencyRecordSchema);
