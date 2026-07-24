// src/models/BillingRecord.js
'use strict';
//
// Factura EMITIDA (M7 Fase 2). En Fase 1 las facturas se calculan al vuelo (borrador
// vivo). Aquí se PERSISTE y se "congela" la de un período CERRADO: una vez finalizada
// es inmutable (factura de registro), aunque cambien transacciones antiguas. Guarda
// además el snapshot de precios aplicado, para que la factura sea reproducible.
//
// Una factura por (merchantId, período). En Fase 1 no se persistía nada; esto es
// justo lo que activa la Fase 2. El cobro real (status 'paid') llega en la Fase 3.
//
const mongoose = require('mongoose');

const billingRecordSchema = new mongoose.Schema({
  merchantId:    { type: String, required: true },
  period:        { type: String, required: true },   // 'YYYY-MM'
  invoiceNumber: { type: String, required: true, unique: true },
  plan:          { type: String },
  currency:      { type: String, default: 'EUR' },

  // Precios aplicados (snapshot — no se recalcula con precios nuevos).
  pricingSnapshot: {
    monthlyBase:       { type: Number, default: 0 },
    perTransactionFee: { type: Number, default: 0 },
    volumeBps:         { type: Number, default: 0 },
  },

  // Cifras congeladas del período.
  transactionsCount: { type: Number, default: 0 },
  billableCount:     { type: Number, default: 0 },
  billableVolume:    { type: Number, default: 0 },   // céntimos
  subscriptionFee:   { type: Number, default: 0 },   // céntimos
  usageFee:          { type: Number, default: 0 },   // céntimos
  volumeFee:         { type: Number, default: 0 },   // céntimos
  totalDue:          { type: Number, default: 0 },   // céntimos

  status:      { type: String, enum: ['finalized', 'paid'], default: 'finalized' },
  finalizedAt: { type: Date, default: Date.now },
  finalizedBy: { type: String, default: null },

  createdAt:   { type: Date, default: Date.now },
  updatedAt:   { type: Date, default: Date.now },
});

billingRecordSchema.index({ merchantId: 1, period: 1 }, { unique: true });
billingRecordSchema.index({ merchantId: 1, finalizedAt: -1 });

billingRecordSchema.pre('save', function (next) { this.updatedAt = new Date(); next(); });

module.exports = mongoose.models.BillingRecord || mongoose.model('BillingRecord', billingRecordSchema);
