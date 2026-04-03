// src/models/Merchant.js
const mongoose = require('mongoose');

const merchantSchema = new mongoose.Schema({
  merchantId:   { type: String, required: true, unique: true },
  merchantName: { type: String },

  // Jerarquía existente
  groupGlobal:  String,
  country:      String,
  group:        String,
  branch:       String,
  region:       String,
  location:     String,

  // Branding dinámico
  logoUrl:      String,
  brandColor:   String,
  accentColor:  String,

  // 🔐 Secretos opcionales (para que el iframe pueda usarlos si están definidos)
  signingSecret: String,
  hmacSecret:    String,
  secret:        String,

  // 🔐 Backoffice login
  email:        { type: String, sparse: true },
  passwordHash: { type: String },

  createdAt:    { type: Date, default: Date.now }
});

// Índice único sparse en email: permite múltiples documentos sin email
merchantSchema.index({ email: 1 }, { unique: true, sparse: true });

module.exports =
  mongoose.models.Merchant ||
  mongoose.model('Merchant', merchantSchema);
