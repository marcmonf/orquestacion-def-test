// src/models/IdempotencyKey.js
const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, index: true },
  bodyHash: { type: String, required: true },
  response: {
    statusCode: Number,
    body: Object
  },
  createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 } // 24h TTL
});

module.exports = mongoose.model('IdempotencyKey', schema);
