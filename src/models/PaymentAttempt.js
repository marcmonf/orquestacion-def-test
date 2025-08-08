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

module.exports = mongoose.model('PaymentAttempt', paymentAttemptSchema);
