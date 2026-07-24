// src/models/InvoiceCounter.js
'use strict';
//
// Contador de numeración de factura (M7 Bloque 1). Numeración fiscal CORRELATIVA y
// SIN HUECOS por serie y año. Se incrementa atómicamente ($inc) al finalizar.
// key = `${serie}-${año}`.
//
const mongoose = require('mongoose');

const invoiceCounterSchema = new mongoose.Schema({
  key:  { type: String, required: true, unique: true },  // p. ej. 'A-2026'
  last: { type: Number, default: 0 },
}, { collection: 'invoicecounters' });

module.exports = mongoose.models.InvoiceCounter || mongoose.model('InvoiceCounter', invoiceCounterSchema);
