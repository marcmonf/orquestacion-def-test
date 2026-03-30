'use strict';
/**
 * src/models/WebhookEvent.js
 *
 * Registro de auditoría de todos los webhooks entrantes que recibe Monetiser
 * (de adquirentes como Paylands/PayNoPain).
 *
 * Se guarda SIEMPRE, tanto si la transacción se actualizó correctamente
 * como si no, para facilitar debugging.
 */
const mongoose = require('mongoose');

const webhookEventSchema = new mongoose.Schema({
  // Identificadores
  paymentId:  { type: String, required: true },
  merchantId: { type: String, default: null },

  // Origen del webhook (qué adquirente lo envió)
  source: { type: String, default: 'unknown' },  // 'paynopain', 'stripe', etc.

  // Evento estandarizado de Monetiser
  event:  { type: String, default: 'payment.updated' },

  // Status mapeado al dominio Monetiser
  status: { type: String, required: true },

  // Payload raw que envió el adquirente (para debugging)
  rawPayload: { type: mongoose.Schema.Types.Mixed, default: null },

  // Campos legacy (se mantienen para compatibilidad con datos anteriores)
  authCode:  { type: String, default: null },
  processor: { type: String, default: null },

  timestamp: { type: Date, default: Date.now },

}, { timestamps: true });

// Índices para consultas frecuentes
webhookEventSchema.index({ paymentId: 1 });
webhookEventSchema.index({ merchantId: 1, timestamp: -1 });
webhookEventSchema.index({ source: 1, timestamp: -1 });

module.exports = mongoose.models.WebhookEvent ||
  mongoose.model('WebhookEvent', webhookEventSchema);
