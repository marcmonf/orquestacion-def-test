// src/storage/transactionModel.js
const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  paymentId:    { type: String, required: true },
  merchantId:   { type: String, required: true },
  amount:       { type: Number, required: true },
  currency:     { type: String, required: true },
  method:       { type: String, required: true }, // ej: card, apm, etc.
  channel:      { type: String },                 // ej: ecommerce, pos, inApp
  status:       { type: String, enum: ['approved', 'declined', 'pending'], default: 'pending' },
  authCode:     { type: String },
  processor:    { type: String },                 // ej: Adyen, Stripe, Worldline

  // Datos para identificar la recurrencia
  isRecurring:  { type: Boolean, default: false },
  recurrenceId: { type: String }, // ID único para vincular la serie de pagos

  // Clasificación de la transacción (CIT/MIT)
  transactionType: { 
    type: String, 
    enum: ['CIT', 'MIT'], 
    required: true 
  },

  // Referencia al token utilizado, si aplica
  token: { type: String },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date }
});

module.exports = mongoose.model('Transaction', transactionSchema);
