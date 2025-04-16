const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  paymentId: String,
  merchantId: String,
  amount: Number,
  currency: String,
  method: String,
  channel: String,
  status: String,
  authCode: String,
  processor: String,
  createdAt: { type: Date, default: Date.now },
  updatedAt: Date
});

module.exports = mongoose.model('Transaction', transactionSchema);
