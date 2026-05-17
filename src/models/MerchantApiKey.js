// src/models/MerchantApiKey.js
'use strict';

const mongoose = require('mongoose');

/**
 * Cada documento representa UN par de credenciales de un merchant:
 *   - keyId     → identificador público, viaja en el header Authorization
 *   - keyHash   → SHA-256 de la API key (no se usa ya para auth, se mantiene por compat)
 *   - secretHash → SHA-256 del API secret, usado para verificar la firma HMAC
 *
 * Flujo HMAC (inspirado en Worldline):
 *   Header: Authorization: GCS v1HMAC:<keyId>:<base64(HMAC-SHA256(secret, stringToHash))>
 *   El servidor busca el doc por keyId, recupera secretHash y verifica la firma.
 *
 * IMPORTANTE: ni keyHash ni secretHash se devuelven nunca en respuestas API.
 * El secret raw solo se muestra UNA VEZ al crear la credencial.
 */
const merchantApiKeySchema = new mongoose.Schema({
  merchantId:  { type: String, required: true, index: true },

  // ── Identificador público ──────────────────────────────────────────────────
  // Se envía en el header Authorization para que el servidor localice el doc.
  // Formato: "mk_<16 bytes hex>" — 35 chars total.
  keyId:       { type: String, required: true, unique: true },

  // Prefijo visual del keyId (primeros 11 chars) para identificación en backoffice
  keyPrefix:   { type: String, required: true },

  // ── Credencial pública (legacy, mantenida por compat) ─────────────────────
  // Hash SHA-256 del valor completo de la API key original.
  // Con HMAC ya no se valida este campo directamente, pero se preserva.
  keyHash:     { type: String, required: true, unique: true },

  // ── Secret para firma HMAC ────────────────────────────────────────────────
  // SHA-256 del secret raw. Se usa para derivar el secret en validación HMAC.
  // NUNCA se devuelve en respuestas API.
  secretHash:  { type: String, required: true },

  // Prefijo visual del secret (primeros 11 chars) — solo para confirmación en UI
  secretPrefix: { type: String, required: true },

  // ── Metadatos ─────────────────────────────────────────────────────────────
  label:       { type: String, default: '' },
  active:      { type: Boolean, default: true, index: true },

  // Auditoría de uso
  lastUsedAt:  { type: Date, default: null },
  lastUsedIp:  { type: String, default: null },

  // Expiración opcional (null = no expira)
  expiresAt:   { type: Date, default: null },

  createdAt:   { type: Date, default: Date.now },
  revokedAt:   { type: Date, default: null }
});

// Índice compuesto para buscar credenciales activas de un merchant
merchantApiKeySchema.index({ merchantId: 1, active: 1 });
// Búsqueda rápida por keyId (el campo que viaja en Authorization)
merchantApiKeySchema.index({ keyId: 1, active: 1 });

module.exports =
  mongoose.models.MerchantApiKey ||
  mongoose.model('MerchantApiKey', merchantApiKeySchema);
