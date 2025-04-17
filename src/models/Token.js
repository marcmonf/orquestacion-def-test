const mongoose = require('mongoose');

const tokenSchema = new mongoose.Schema({
  token: { type: String, required: true, unique: true },
  pan: { type: String, required: true },
  expiry: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
}, {
  timestamps: true
});

module.exports = mongoose.model('Token', tokenSchema);
