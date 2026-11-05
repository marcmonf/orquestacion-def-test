// src/models/Terminal.js
'use strict';
//
// TERMINAL FÍSICO de una tienda (F5 card present, nov 2026 — APAGADO con
// FEATURE_CARD_PRESENT). Ligado a un nodo de la jerarquía (HierarchyNode =
// tienda). Hoy solo inventario: sin SDK del terminal ni PSP card present.

const mongoose = require('mongoose');

const terminalSchema = new mongoose.Schema({
  terminalId:      { type: String, required: true, unique: true },   // trm_<hex>
  merchantId:      { type: String, required: true },
  hierarchyNodeId: { type: String, required: true },                  // tienda
  label:           { type: String, required: true },                  // "Caja 1"
  model:           { type: String, default: null },                   // "PAX A920Pro"
  serialNumber:    { type: String, default: null },
  status:          { type: String, enum: ['active', 'disabled'], default: 'active' },
  // PSP card present asignado (cuando exista uno con capabilities.cardPresent).
  connector:       { type: String, default: null },
  createdBy:       { type: String, default: null },
  createdAt:       { type: Date, default: Date.now },
  updatedAt:       { type: Date, default: Date.now },
});

terminalSchema.index({ merchantId: 1, hierarchyNodeId: 1 });

module.exports = mongoose.models.Terminal || mongoose.model('Terminal', terminalSchema);
