// src/models/RecurrentProfile.js
const mongoose = require('mongoose');

const RecurrentProfileSchema = new mongoose.Schema({
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
    type: String,
    required: true
  },
  expiryMonth: {
    type: String,
    required: true
  },
  expiryYear: {
    type: String,
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('RecurrentProfile', RecurrentProfileSchema);
