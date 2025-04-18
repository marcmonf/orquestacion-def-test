const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  paymentId: { type: String, required: true },
  merchantId: { type: String, required: true },
  amount: { type: Number, required: true },
  currency: { type: String, required: true },
  method: { type: String, required: true }, // card, bizum, blik, mbway...
  status: { type: String, required: true }, // approved, declined, pending, etc.
  authCode: { type: String },
  processor: { type: String },
  fallbackUsed: { type: Boolean, default: false },

  // Campos opcionales para APMs
  phone: { type: String },               // MB WAY
  apmReference: { type: String },        // ID o código generado por el APM
  apmExtraData: { type: Object },        // Para extensiones o metadatos adicionales del APM

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.models.Transaction || mongoose.model('Transaction', transactionSchema);
