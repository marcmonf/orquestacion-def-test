// src/models/Operation.js
'use strict';
const mongoose = require('mongoose');

const operationSchema = new mongoose.Schema({
  paymentId: { type: String, required: true, index: true },
  type: { type: String, enum: ['capture', 'refund', 'cancel'], required: true },
  idempotencyKey: { type: String, required: true }, // <— NUEVO: clave idempotente

  // Datos de negocio
  amount: { type: Number },
  currencyCode: { type: String },
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
  captureId: { type: String },
  reason: { type: String },
  operatorId: { type: String },

  // Trazabilidad y re-entrega determinista
  status: { type: String, enum: ['pending', 'succeeded', 'failed'], default: 'succeeded' },
  responseStatusCode: { type: Number, default: 200 },
  responseSnapshot: { type: mongoose.Schema.Types.Mixed }, // JSON devuelto al merchant

  createdAt: { type: Date, default: Date.now }
});

// Índice único robusto contra duplicación concurrente
operationSchema.index(
  { paymentId: 1, type: 1, idempotencyKey: 1 },
  { unique: true, name: 'uniq_payment_type_idemKey' }
);

module.exports = mongoose.models.Operation ||
  mongoose.model('Operation', operationSchema);
