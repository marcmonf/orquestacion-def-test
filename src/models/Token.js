// src/models/Token.js
const mongoose = require('mongoose');

const tokenSchema = new mongoose.Schema({
  token:          { type: String, required: true, unique: true },
  pan:            { type: String, required: true }, // cifrado
  bin:            { type: String, required: true },
  last4:          { type: String, required: true },
  expiryMonth:    { type: String, required: true },
  expiryYear:     { type: String, required: true },
  cardholderName: { type: String, required: true }
}, {
  timestamps: true // Crea automáticamente createdAt y updatedAt
});

module.exports = mongoose.models.Token || mongoose.model('Token', tokenSchema);
