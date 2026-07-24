// src/models/MerchantContract.js
'use strict';
//
// Contrato / tarifa por merchant (M7 Bloque 1). Lo configura el superadmin y se le
// PRECARGA al merchant en su ficha. Es la fuente de verdad para facturar a ESE
// merchant (pasarela + servicios); si no existe contrato, el billing cae a la
// tarifa por plan (PricingPlan) por compatibilidad.
//
// SOLO cubre lo NUESTRO (pasarela + servicios). La adquirencia es informativa y va
// en el Bloque 2 — nunca se factura aquí (somos capa tecnológica, no payfac).
//
// Importes en CÉNTIMOS.
//
const mongoose = require('mongoose');

const recipientSchema = new mongoose.Schema({
  legalName:  { type: String, default: '' },
  taxId:      { type: String, default: '' },
  street:     { type: String, default: '' },
  city:       { type: String, default: '' },
  postalCode: { type: String, default: '' },
  province:   { type: String, default: '' },
  country:    { type: String, default: 'ES' },
  email:      { type: String, default: '' },   // a dónde se envía la factura
}, { _id: false });

const serviceSchema = new mongoose.Schema({
  code:         { type: String, required: true },
  label:        { type: String, default: '' },
  monthlyPrice: { type: Number, default: 0 },   // céntimos/mes
  active:       { type: Boolean, default: true },
}, { _id: false });

const merchantContractSchema = new mongoose.Schema({
  merchantId: { type: String, required: true, unique: true },

  // Datos fiscales del RECEPTOR (el merchant), para la factura.
  billing:    { type: recipientSchema, default: () => ({}) },
  taxRateCode:{ type: String, default: 'IGIC_GENERAL' },  // Canarias: IGIC; Península/UE: NO_SUJETO/ISP…
  currency:   { type: String, default: 'EUR' },

  // Rate-card de la pasarela (lo nuestro).
  monthlyMaintenance: { type: Number, default: 0 },  // céntimos/mes
  perTransactionFee:  { type: Number, default: 0 },  // céntimos por transacción facturable
  volumeBps:          { type: Number, default: 0 },  // puntos básicos sobre volumen
  perUserFee:         { type: Number, default: 0 },  // céntimos por usuario (por encima de includedUsers)
  includedUsers:      { type: Number, default: 0 },  // usuarios incluidos sin coste

  // Servicios / módulos extra (cada uno con precio mensual). Ej.: acceso al módulo
  // de pricing, alta de adquirentes, etc.
  services:   { type: [serviceSchema], default: [] },

  active:     { type: Boolean, default: true },
  updatedBy:  { type: String, default: null },
  updatedAt:  { type: Date, default: Date.now },
}, { collection: 'merchantcontracts' });

merchantContractSchema.pre('save', function (next) { this.updatedAt = new Date(); next(); });

module.exports = mongoose.models.MerchantContract || mongoose.model('MerchantContract', merchantContractSchema);
