// src/models/PaymentAttempt.js
const mongoose = require('mongoose');

const paymentAttemptSchema = new mongoose.Schema(
  {
    paymentId:    { type: String, required: true, index: true },
    connector:    { type: String, required: true },
    attemptNumber:{ type: Number, required: true },
    status:       { type: String, required: true },
    reasonCode:   { type: String }
  },
  { timestamps: true }
);

// Índices útiles para consultas y métricas
paymentAttemptSchema.index({ paymentId: 1, connector: 1 });
paymentAttemptSchema.index({ createdAt: -1 });

module.exports = mongoose.model('PaymentAttempt', paymentAttemptSchema);
