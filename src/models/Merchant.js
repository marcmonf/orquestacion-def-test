const mongoose = require('mongoose');

const merchantSchema = new mongoose.Schema({
  merchantId: { type: String, required: true, unique: true },
  merchantName: String,
  groupGlobal: String,     // Grupo multinacional (p. ej. Inditex Global)
  country: String,         // País del merchant
  group: String,           // Subgrupo por país (p. ej. Inditex España)
  branch: String,          // Marca (p. ej. Zara)
  region: String,          // Región (p. ej. Madrid)
  location: String,        // Tienda específica (p. ej. Alberto Aguilera)
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Merchant', merchantSchema);
