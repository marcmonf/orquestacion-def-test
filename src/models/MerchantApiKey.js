// src/models/MerchantApiKey.js
'use strict';

const mongoose = require('mongoose');

/**
 * Cada documento representa UNA API key de un merchant.
 * Un merchant puede tener múltiples keys activas (útil para rotación).
 *
 * La key en sí se guarda como hash SHA-256 — nunca en claro.
 * El prefijo (primeros 8 chars) se guarda en claro para identificación
 * visual sin exponer la key completa. Ej: "mk_live_a3f2b1c9..."
 */
const merchantApiKeySchema = new mongoose.Schema({
  merchantId:  { type: String, required: true, index: true },

  // Prefijo visible para identificar la key sin exponerla
  // Ej: "mk_a3f2b1c9" — primeros 8 chars del valor en claro
  keyPrefix:   { type: String, required: true },

  // Hash SHA-256 del valor completo de la key — lo que se compara en auth
  keyHash:     { type: String, required: true, unique: true },

  // Descripción opcional para identificar el uso ("producción", "sandbox", "integración ERP")
  label:       { type: String, default: '' },

  // Estado de la key
  active:      { type: Boolean, default: true, index: true },

  // Auditoría de uso
  lastUsedAt:  { type: Date, default: null },
  lastUsedIp:  { type: String, default: null },

  // Expiración opcional (null = no expira)
  expiresAt:   { type: Date, default: null },

  createdAt:   { type: Date, default: Date.now },
  revokedAt:   { type: Date, default: null }
});

// Índice compuesto para buscar keys activas de un merchant rápidamente
merchantApiKeySchema.index({ merchantId: 1, active: 1 });

module.exports =
  mongoose.models.MerchantApiKey ||
  mongoose.model('MerchantApiKey', merchantApiKeySchema);
