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

  // 🆕 Branding dinámico
  logoUrl:      String,   // URL absoluta o path relativo a /public
  brandColor:   String,   // Ej. "#2b6cb0"
  accentColor:  String,   // Ej. "#e67e22"

  createdAt:    { type: Date, default: Date.now }
});

module.exports =
  mongoose.models.Merchant ||
  mongoose.model('Merchant', merchantSchema);
