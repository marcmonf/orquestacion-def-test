// src/models/Transaction.js
'use strict';
/**
 * src/models/Transaction.js
 */
const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  paymentId:          { type: String, required: true, unique: true },
  merchantId:         { type: String, required: true },

  // Referencia propia del merchant (orderId, bookingId, etc.)
  merchantReference:  { type: String },

  // Referencia del adquirente (orderUuid de Paylands, etc.)
  // Usada por el webhook entrante para encontrar la transacción correcta
  processorReference: { type: String, default: null },

  amount:             { type: Number, required: true },
  currency:           { type: String, required: true },
  method:             { type: String, required: true },
  status:             { type: String, required: true },

  // Tarjeta (solo cuando el merchant postea los datos)
  cardholderName:     { type: String },
  expiryMonth:        { type: String },
  expiryYear:         { type: String },
  bin:                { type: String },
  cardLast4:          { type: String },   // últimos 4 (truncado permitido por PCI DSS)

  /* BIN enrichment */
  cardBrand:          { type: String },
  cardType:           { type: String },
  cardLevel:          { type: String },
  issuerName:         { type: String },
  issuerCountry:      { type: String },
  bankPhone:          { type: String },
  countryCurrency:    { type: String },

  // Otros
  authCode:           String,
  processor:          String,
  fallbackUsed:       { type: Boolean, default: false },
  returnUrl:          String,
  callbackUrl:        String,

  // Tracking iFrame
  iframeServedAt:     Date,
  iframeClientIp:     String,
  iframeUserAgent:    String,

  // Campos adicionales para hosted checkout
  hostedCheckoutId:      String,
  hostedTokenizationId:  String,
  hostedFieldsSessionId: String,
  // Caducidad de la sesión de pago (30 min desde la creación). NO estaba
  // declarado: Mongoose lo descartaba en silencio al guardar (mismo bug que
  // lastWebhookAt), así que /hpp no caducaba nunca y GET status devolvía
  // `expired:false` siempre, aunque la API anunciaba `session.expiresAt`.
  sessionExpiresAt:      Date,

  // Traza del último webhook entrante del adquirente.
  // IMPORTANTE: estos campos NO estaban declarados y Mongoose los descartaba
  // en silencio (bug histórico del proyecto), lo que hacía imposible depurar
  // qué status exacto había mandado Paylands en la última notificación.
  lastWebhookAt:      Date,
  lastWebhookRaw:     {
    source:    String,   // 'paynopain'
    status:    String,   // status crudo tal cual lo manda el adquirente
    orderUuid: String,
  },

  // Bloqueo por pago de capture/refund/cancel (ver paymentLifecycleService).
  // Lease con caducidad: si el proceso muere a mitad, se libera solo.
  opLockUntil:        { type: Date, default: null },
  opLockId:           { type: String, default: null },

  createdAt:          { type: Date, default: Date.now },
  updatedAt:          { type: Date, default: Date.now }
});

transactionSchema.index({ merchantId: 1 });
transactionSchema.index({ createdAt: -1 });
transactionSchema.index({ bin: 1 });
transactionSchema.index({ issuerCountry: 1 });
transactionSchema.index({ merchantReference: 1 });
transactionSchema.index({ processorReference: 1 }); // ← para búsqueda rápida por webhook
transactionSchema.index({ hostedCheckoutId: 1 });
// Listados, analíticas y facturación filtran por merchant + fecha (+ estado):
// con índices sueltos cada consulta recorría todo el histórico del merchant.
transactionSchema.index({ merchantId: 1, createdAt: -1 });
transactionSchema.index({ merchantId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.models.Transaction ||
  mongoose.model('Transaction', transactionSchema);
