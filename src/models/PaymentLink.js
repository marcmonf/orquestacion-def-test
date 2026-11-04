// src/models/PaymentLink.js
'use strict';
//
// ENLACE DE PAGO (nov 2026, segunda sesión). El comercio lo crea (API v1,
// portal o /admin), lo comparte (URL o QR) y el comprador paga en el checkout
// de siempre (PCI SAQ A: la tarjeta solo se escribe en los campos del PSP).
// Cada pago es una transacción normal con su webhook de siempre; el enlace
// solo agrupa y limita.

const mongoose = require('mongoose');

const paymentLinkSchema = new mongoose.Schema({
  linkId:      { type: String, required: true, unique: true },   // pl_<hex>: va en la URL pública
  merchantId:  { type: String, required: true },
  livemode:    { type: Boolean, default: false },
  amount:      { type: Number, required: true },                  // céntimos
  currency:    { type: String, required: true },
  concept:     { type: String, required: true },                  // lo que ve el comprador
  reference:   { type: String, default: null },                   // referencia del comercio
  reusable:    { type: Boolean, default: false },                 // false = uso único
  expiresAt:   { type: Date, default: null },
  returnUrl:   { type: String, default: null },
  webhookUrl:  { type: String, default: null },
  status:      { type: String, enum: ['active', 'completed', 'cancelled'], default: 'active' },
  paidCount:   { type: Number, default: 0 },                      // pagos aprobados
  // Uso único: sesión de pago en curso (un solo comprador a la vez → nunca
  // dos cobros del mismo enlace de uso único).
  openPaymentId:   { type: String, default: null },
  openUntil:       { type: Date, default: null },
  createdBy:   { type: String, default: null },                   // 'api' | email de portal/admin
  // Origen: 'api' | 'portal' | 'admin' | 'pos' (terminal en tienda) y la tienda
  // (HierarchyNode) desde la que se cobró, para el historial del terminal.
  channel:     { type: String, default: null },
  hierarchyNodeId: { type: String, default: null },
  cancelledAt: { type: Date, default: null },
  cancelledBy: { type: String, default: null },
  createdAt:   { type: Date, default: Date.now },
  updatedAt:   { type: Date, default: Date.now },
});

paymentLinkSchema.index({ merchantId: 1, createdAt: -1 });
paymentLinkSchema.index({ merchantId: 1, hierarchyNodeId: 1, createdAt: -1 });

module.exports = mongoose.models.PaymentLink || mongoose.model('PaymentLink', paymentLinkSchema);
