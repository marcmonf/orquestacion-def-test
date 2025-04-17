const mongoose = require('mongoose');

const apmTransactionSchema = new mongoose.Schema({
  paymentId: { type: String, required: true },
  merchantId: { type: String, required: true },
  amount: { type: Number, required: true },
  currency: { type: String, required: true },
  method: { type: String, required: true },
  processor: { type: String, required: true },
  status: { type: String, required: true },
  authCode: { type: String },
  fallbackUsed: { type: Boolean, default: false },
  // Puedes añadir campos específicos por APM si los necesitas más adelante
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('ApmTransaction', apmTransactionSchema);
