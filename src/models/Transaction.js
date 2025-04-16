const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  amount: Number,
  currency: String,
  status: String,
  reference: String,
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.models.Transaction || mongoose.model('Transaction', transactionSchema);
