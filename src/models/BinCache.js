// src/models/BinCache.js
const mongoose = require('mongoose');

const binCacheSchema = new mongoose.Schema({
  bin:            { type: String, required: true, unique: true },
  cardBrand:      String,
  cardType:       String,
  cardLevel:      String,
  issuerName:     String,
  issuerCountry:  String,
  bankPhone:      String,
  countryCurrency:String,
  updatedAt:      { type: Date, default: Date.now }
});

// TTL index: 7 días
binCacheSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 604800 });

module.exports = mongoose.models.BinCache ||
  mongoose.model('BinCache', binCacheSchema);
