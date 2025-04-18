const mongoose = require('mongoose');

const merchantHierarchySchema = new mongoose.Schema({
  globalGroup: { type: String, required: true },     // Nivel superior (ej: Inditex Global)
  country:     { type: String, required: true },     // País (ej: España)
  group:       { type: String, required: true },     // Subgrupo si aplica (ej: Inditex)
  branch:      { type: String, required: true },     // Marca (ej: Zara)
  region:      { type: String, required: true },     // Región o ciudad (ej: Madrid)
  merchantId:  { type: String, required: true, unique: true }, // ID tienda (ej: zara_mad_001)
  name:        { type: String },                     // Nombre opcional (ej: Zara Alberto Aguilera)
  active:      { type: Boolean, default: true }
}, {
  timestamps: true
});

module.exports = mongoose.model('MerchantHierarchy', merchantHierarchySchema);
