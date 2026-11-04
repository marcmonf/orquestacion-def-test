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
  // Conector que PROCESÓ el pago (se fija al cobrar). Puede diferir de
  // routing.connector solo si el pago es anterior al framework multi-PSP.
  processor:          String,

  // ── Routing pre-captura (framework multi-PSP, nov 2026) ───────────────────
  // Decisión completa tomada al crear la sesión (src/services/routingService):
  // conector, cuenta, regla que casó, candidatos descartados y por qué
  // (explain). Las transacciones anteriores no lo tienen → Paylands.
  routing:            { type: mongoose.Schema.Types.Mixed, default: undefined },
  // Cuenta del merchant en el PSP con la que se opera ('platform' = cuenta de
  // plataforma, variables de entorno). Ver connectorAccountService.
  connectorAccountId: { type: String, default: null },

  // Modo (F4, estilo Stripe): false = test (sandbox), true = live. Los pagos
  // anteriores no lo tienen → test. Aísla datos por modo en la API v1.
  livemode:           { type: Boolean, default: false },

  // Métodos que el comercio permitió en la sesión (F5, API v1). Sin el campo:
  // los disponibles (hoy solo tarjeta). `method` sigue siendo el método usado.
  paymentMethods:     { type: [String], default: undefined },

  // ── Tarjeta guardada / recurrentes (F6, detrás de FEATURE_SAVED_CARDS) ────
  // Oferta de guardar la tarjeta en esta sesión (cliente del comercio).
  saveCardOffer:      { customerRef: { type: String } },
  // Quién inicia el pago: 'customer' (CIT, cliente delante) o 'merchant' (MIT).
  initiator:          { type: String, default: undefined },
  // Credencial guardada: 'first' (pago que la guarda) o 'subsequent' (pago con
  // el token pm_), su motivo y el token Monetiser usado.
  storedCredential:   {
    usage:   { type: String },
    reason:  { type: String },
    tokenId: { type: String },
  },
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

  // Idempotency-Key con la que se creó el pago en la API v1 (POST
  // /v1/checkout-sessions). Un reintento con la misma clave devuelve la misma
  // sesión en vez de crear otro pago. Índice único parcial más abajo.
  idempotencyKey:     { type: String },

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
// Solo los pagos creados con Idempotency-Key (el resto no lleva el campo).
transactionSchema.index(
  { merchantId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } }
);

module.exports = mongoose.models.Transaction ||
  mongoose.model('Transaction', transactionSchema);
