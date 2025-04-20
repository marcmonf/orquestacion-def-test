const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  paymentId:     { type: String, required: true, unique: true },
  merchantId:    { type: String, required: true },
  amount:        { type: Number, required: true },
  currency:      { type: String, required: true },
  method:        { type: String, required: true },
  status:        { type: String, required: true },
  cardholderName:{ type: String, required: true },
  expiryMonth:   { type: String, required: true }, // MM (01–12)
  expiryYear:    { type: String, required: true }, // YYYY (2025...)
  authCode:      { type: String },
  processor:     { type: String },
  fallbackUsed:  { type: Boolean, default: false },
  phone:         { type: String },
  apmReference:  { type: String },
  apmExtraData:  { type: Object },
  createdAt:     { type: Date, default: Date.now },
  updatedAt:     { type: Date, default: Date.now }
});

// Índices para optimizar búsquedas
transactionSchema.index({ merchantId: 1 });
transactionSchema.index({ createdAt: -1 });
transactionSchema.index({ method: 1 });
transactionSchema.index({ status: 1 });
transactionSchema.index({ paymentId: 1 }, { unique: true });

module.exports = mongoose.models.Transaction || mongoose.model('Transaction', transactionSchema);
