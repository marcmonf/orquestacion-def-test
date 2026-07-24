// src/models/CompanyProfile.js
'use strict';
//
// Datos de la SOCIEDAD emisora de las facturas (M7 Bloque 1). Singleton: un único
// documento (`key: 'default'`). Lo rellena el superadmin (GET/PUT /backoffice/company).
// Sociedad en Canarias ⇒ régimen IGIC por defecto.
//
const mongoose = require('mongoose');

const addressSchema = new mongoose.Schema({
  street:     { type: String, default: '' },
  city:       { type: String, default: '' },
  postalCode: { type: String, default: '' },
  province:   { type: String, default: '' },   // Las Palmas / Santa Cruz de Tenerife
  country:    { type: String, default: 'ES' },
}, { _id: false });

const companyProfileSchema = new mongoose.Schema({
  key:        { type: String, default: 'default', unique: true },  // singleton
  legalName:  { type: String, default: '' },   // razón social
  tradeName:  { type: String, default: '' },   // nombre comercial
  taxId:      { type: String, default: '' },   // NIF / CIF
  address:    { type: addressSchema, default: () => ({}) },
  email:      { type: String, default: '' },
  phone:      { type: String, default: '' },
  iban:       { type: String, default: '' },   // opcional, para el pie de la factura
  taxRegime:  { type: String, default: 'IGIC' },
  invoiceSeries: { type: String, default: 'A' },
  logoDataUrl:   { type: String, default: '' }, // logo opcional (data URL) para la factura
  footerNotes:   { type: String, default: '' }, // texto libre al pie (condiciones, etc.)
  updatedBy:  { type: String, default: null },
  updatedAt:  { type: Date, default: Date.now },
}, { collection: 'companyprofiles' });

companyProfileSchema.pre('save', function (next) { this.updatedAt = new Date(); next(); });

module.exports = mongoose.models.CompanyProfile || mongoose.model('CompanyProfile', companyProfileSchema);
