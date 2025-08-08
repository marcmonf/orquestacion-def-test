const mongoose = require('mongoose');

const paymentAttemptSchema = new mongoose.Schema(
  {
    paymentId: { type: String, required: true, index: true },
    connector: { type: String, required: true },
    attemptNumber: { type: Number, required: true },
    success: { type: Boolean, required: true },
    responseCode: { type: String, required: true },
    processorReference: { type: String },
  },
  { timestamps: true }
);

module.exports = mongoose.model('PaymentAttempt', paymentAttemptSchema);
