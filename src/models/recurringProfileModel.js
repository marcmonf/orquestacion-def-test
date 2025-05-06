// src/models/recurringProfileModel.js
const mongoose = require('mongoose');

const recurringProfileSchema = new mongoose.Schema({
  recurrenceId: {
    type: String,
    required: true,
    unique: true
  },
  token: {
    type: String,
    required: true
  },
  merchantId: {
    type: String,
    required: true
  },
  cardholderName: {
    type: String
  },
  expiryMonth: {
    type: String
  },
  expiryYear: {
    type: String
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('RecurringProfile', recurringProfileSchema);
