// src/models/MerchantHierarchy.js
//
// ┌─────────────────────────────────────────────────────────────────────────┐
// │  EN STANDBY — REACTIVAR CUANDO EL NEGOCIO LO NECESITE                     │
// │                                                                           │
// │  Este modelo representa la ORGANIZACIÓN CORPORATIVA de un cliente grande  │
// │  (globalGroup → group → branch → region → tienda). Es una funcionalidad   │
// │  legítima y pensada a largo plazo: un cliente enterprise (ej: un gran     │
// │  grupo retail u hotelero) querrá configurar su estructura jerárquica.     │
// │                                                                           │
// │  HOY NO SE USA: no está montado en index.js y el modelo operativo del     │
// │  día a día es src/models/Merchant.js. Paylands tampoco necesita esta      │
// │  jerarquía para procesar pagos (trabaja por `service`, no por organigrama)│
// │                                                                           │
// │  PUENTE YA CONSTRUIDO: el modelo Merchant tiene el campo `hierarchyId`    │
// │  (ObjectId, ref: 'MerchantHierarchy', default: null). El día que se       │
// │  active la jerarquía, basta con empezar a rellenar ese campo y colgar los │
// │  nodos aquí — NO hay que rehacer el modelo Merchant.                      │
// │                                                                           │
// │  PARA REACTIVAR:                                                          │
// │   1. Montar sus rutas en index.js (crear/leer nodos de jerarquía).        │
// │   2. Empezar a poblar Merchant.hierarchyId con el _id del nodo.           │
// │   3. Añadir las consultas de agregación por nivel que el negocio pida.    │
// └─────────────────────────────────────────────────────────────────────────┘
//
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
