// src/models/Operation.js
'use strict';
const mongoose = require('mongoose');

const operationSchema = new mongoose.Schema({
  paymentId: { type: String, required: true, index: true },
  type: { type: String, enum: ['capture', 'refund', 'cancel'], required: true },
  amount: { type: Number },                  // capture/refund amount
  currencyCode: { type: String },            // ISO 4217
  isFinal: { type: Boolean },
  references: {
    merchantReference: { type: String },
    merchantParameters: { type: String },
    operationGroupReference: { type: String }
  },
  operationReferences: {
    merchantReference: { type: String },
    operationGroupReference: { type: String }
  },
  captureId: { type: String },               // opcional (si lo usas)
  reason: { type: String },                  // refund reason
  operatorId: { type: String },              // omnichannelRefundSpecificInput.operatorId
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.models.Operation ||
  mongoose.model('Operation', operationSchema);
