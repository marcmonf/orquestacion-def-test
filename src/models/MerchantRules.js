'use strict';
const mongoose = require('mongoose');

const MerchantRulesSchema = new mongoose.Schema({
  merchantId: { type: String, required: true, unique: true, index: true },
  policy: { type: Object, required: true }, // validado en capa de negocio con JSON Schema si quieres
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, { collection: 'MerchantRules' });

MerchantRulesSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.models.MerchantRules ||
  mongoose.model('MerchantRules', MerchantRulesSchema);
