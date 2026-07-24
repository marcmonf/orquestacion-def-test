// src/models/MerchantAcquirer.js
'use strict';
//
// Ficha de un adquirente PARA UN MERCHANT (M7 Bloque 2): qué adquirentes usa el
// merchant y con qué PRICING negociado (ICH++). Uno por (merchantId, acquirerCode).
//
// Pricing ICH++ = interchange + scheme fees (pass-through) + MARGEN del adquirente.
// Aquí se guarda ese margen negociado:
//   - markupBps / fixedFee: el "++" para el grueso de operaciones ("resto").
//   - onUsMarkupBps: margen para operaciones on-us (emisor = adquirente). La
//     DETECCIÓN de on-us necesita datos que hoy no tenemos con fiabilidad, así que
//     v1 usa el margen "resto"; el campo queda listo para cuando se pueda detectar.
//
const mongoose = require('mongoose');

const merchantAcquirerSchema = new mongoose.Schema({
  merchantId:   { type: String, required: true },
  acquirerCode: { type: String, required: true },
  active:       { type: Boolean, default: true },
  isDefault:    { type: Boolean, default: false },  // adquirente por defecto del merchant
  priority:     { type: Number, default: 100 },     // menor = antes en el routing

  // Pricing negociado (ICH++). Céntimos y bps.
  markupBps:     { type: Number, default: 0 },   // margen del adquirente (resto)
  onUsMarkupBps: { type: Number, default: 0 },   // margen on-us (futuro)
  fixedFee:      { type: Number, default: 0 },   // céntimos por operación

  config:    { type: mongoose.Schema.Types.Mixed, default: {} },  // serviceUuid propio, etc.
  updatedBy: { type: String, default: null },
  updatedAt: { type: Date, default: Date.now },
}, { collection: 'merchantacquirers' });

merchantAcquirerSchema.index({ merchantId: 1, acquirerCode: 1 }, { unique: true });
merchantAcquirerSchema.pre('save', function (next) { this.updatedAt = new Date(); next(); });

module.exports = mongoose.models.MerchantAcquirer || mongoose.model('MerchantAcquirer', merchantAcquirerSchema);
