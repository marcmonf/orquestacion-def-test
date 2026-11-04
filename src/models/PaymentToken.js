// src/models/PaymentToken.js
'use strict';
//
// TARJETA GUARDADA — token PROPIO de Monetiser (F6 framework multi-PSP, nov 2026).
//
// El comercio solo ve `tokenId` (pm_...). El token del PSP (en Paylands, el
// source_uuid de ProxyFields) es COBRABLE: se guarda cifrado (AES-256-GCM,
// cryptoUtils.encryptSecret) y nunca sale de Monetiser. Cada token está atado a
// su merchantId y a su modo: otro comercio (u otro modo) no lo puede usar.
//
// PCI SAQ A: aquí no hay PAN ni CVV; solo marca, últimos 4, BIN y caducidad
// (truncado permitido) y el token del PSP cifrado.
//
// TODO detrás de FEATURE_SAVED_CARDS (apagado): pendiente de verificar con
// PayNoPain que el source_uuid se puede reutilizar y qué indicadores exige un
// cobro sin el cliente delante.

const mongoose = require('mongoose');

const paymentTokenSchema = new mongoose.Schema({
  tokenId:      { type: String, required: true, unique: true },   // pm_<hex>
  merchantId:   { type: String, required: true },
  livemode:     { type: Boolean, default: false },
  customerRef:  { type: String, required: true },                  // id del cliente en el comercio
  connector:    { type: String, required: true },                  // PSP que emitió el token
  connectorAccountId: { type: String, default: null },
  pspTokenEnc:  { type: String, required: true },                  // token del PSP CIFRADO
  card: {
    brand:   String,
    last4:   String,
    bin:     String,
    country: String,
    expMonth: String,
    expYear:  String,
  },
  // Consentimiento del titular a guardar la tarjeta (checkbox del checkout).
  consent: {
    at:          Date,
    ip:          String,
    userAgent:   String,
    textVersion: String,
  },
  firstPaymentId: { type: String, required: true },   // pago inicial (CIT) que creó el token
  status: { type: String, enum: ['pending', 'active', 'revoked'], default: 'pending' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  revokedAt: { type: Date, default: null },
});

paymentTokenSchema.index({ merchantId: 1, livemode: 1, customerRef: 1 });
paymentTokenSchema.index({ firstPaymentId: 1 });

module.exports = mongoose.models.PaymentToken || mongoose.model('PaymentToken', paymentTokenSchema);
