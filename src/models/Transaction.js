// src/models/Transaction.js
'use strict';
const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  paymentId:      { type: String, required: true, unique: true },
  merchantId:     { type: String, required: true },
  amount:         { type: Number, required: true },
  currency:       { type: String, required: true },
  method:         { type: String, required: true },
  status:         { type: String, required: true },

  // Hosted Checkout / HPP
  hostedCheckoutId: { type: String, index: true },
  sessionExpiresAt: { type: Date },

  // Tarjeta (solo cuando el merchant postea los datos)
  cardholderName: { type: String },
  expiryMonth:    { type: String },
  expiryYear:     { type: String },
  bin:            { type: String, length: 8 },

  /* BIN enrichment */
  cardBrand:      { type: String },
  cardType:       { type: String },
  cardLevel:      { type: String },
  issuerName:     { type: String },
  issuerCountry:  { type: String },
  bankPhone:      { type: String },
  countryCurrency:{ type: String },

  // Otros
  authCode:       String,
  processor:      String,
  fallbackUsed:   { type: Boolean, default: false },
  returnUrl:      String,
  callbackUrl:    String,   // ← para webhooks

  // Tracking iFrame
  iframeServedAt:   Date,
  iframeClientIp:   String,
  iframeUserAgent:  String,

  createdAt:      { type: Date, default: Date.now },
  updatedAt:      { type: Date, default: Date.now }
});

transactionSchema.index({ merchantId: 1 });
transactionSchema.index({ createdAt: -1 });
transactionSchema.index({ bin: 1 });
transactionSchema.index({ issuerCountry: 1 });
transactionSchema.index({ hostedCheckoutId: 1 });

module.exports = mongoose.models.Transaction ||
  mongoose.model('Transaction', transactionSchema);
