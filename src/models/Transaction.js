// src/models/Transaction.js
const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  paymentId:      { type: String, required: true,  unique: true },
  merchantId:     { type: String, required: true },
  amount:         { type: Number, required: true },
  currency:       { type: String, required: true },
  method:         { type: String, required: true },
  status:         { type: String, required: true },

  // Datos de tarjeta (opcionales en estado initialized)
  cardholderName: { type: String, required: false },
  expiryMonth:    { type: String, required: false },
  expiryYear:     { type: String, required: false },

  authCode:       { type: String },
  processor:      { type: String },
  fallbackUsed:   { type: Boolean, default: false },
  phone:          { type: String },
  apmReference:   { type: String },
  apmExtraData:   { type: Object },
  returnUrl:      { type: String },

  // Hospitality-specific fields
  reservationId:  { type: String },
  guestName:      { type: String },
  checkInDate:    { type: Date },
  checkOutDate:   { type: Date },
  roomType:       { type: String },
  rateCode:       { type: String },
  channel:        { type: String },
  folioNumber:    { type: String },

  // 🆕 Tracking de carga del iFrame
  iframeServedAt: { type: Date },

  createdAt:      { type: Date, default: Date.now },
  updatedAt:      { type: Date, default: Date.now }
});

// Índices para optimizar búsquedas
transactionSchema.index({ merchantId: 1 });
transactionSchema.index({ createdAt: -1 });
transactionSchema.index({ method: 1 });
transactionSchema.index({ status: 1 });
transactionSchema.index({ paymentId: 1 }, { unique: true });

module.exports =
  mongoose.models.Transaction ||
  mongoose.model('Transaction', transactionSchema);
