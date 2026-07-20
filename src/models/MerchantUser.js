// src/models/MerchantUser.js
'use strict';
//
// MODELO DE USUARIO DE MERCHANT (plano del portal — M6 Fase 1).
//
// PLANO SEPARADO A PROPÓSITO del usuario interno (BackofficeUser):
//   - BackofficeUser  = personal de Monetiser (superadmin/admin/operator/viewer),
//     con merchantScope (puede ver varios/todos los merchants). Entra por
//     /backoffice con BACKOFFICE_JWT_SECRET.
//   - MerchantUser    = usuario de UN comercio, atado a un único merchantId
//     INMUTABLE. Entra por el portal (/portal) con un JWT propio (PORTAL_JWT_SECRET,
//     aud: 'portal').
//
// Son COLECCIONES DISTINTAS por diseño: una consulta del plano merchant NUNCA
// puede devolver un usuario interno, ni con un filtro con bug. Es la garantía
// dura de "un merchant_admin jamás toca usuarios internos" (M6). Ver también el
// bug cross-tenant del DEV-LOG §4 (PUT/DELETE /transactions sin comprobar
// pertenencia): ese patrón no se repite — el aislamiento va SIEMPRE por sesión.
//
// Roles v1 (fijos, sin editor de permisos custom):
//   merchant_admin    → usuarios, jerarquía y configuración de SU merchant
//   merchant_operator → ver transacciones y operar refund/capture/cancel
//   merchant_viewer   → solo lectura
//
const mongoose = require('mongoose');

const merchantUserSchema = new mongoose.Schema({
  // ── Tenant (INMUTABLE) ─────────────────────────────────────
  // El merchant al que pertenece este usuario. No se cambia nunca tras crear:
  // mover un usuario de merchant = crear otro. Todo el aislamiento del portal se
  // apoya en este campo, resuelto SIEMPRE desde la sesión, nunca desde el cliente.
  merchantId: { type: String, required: true, immutable: true },

  // ── Identidad ──────────────────────────────────────────────
  // email único en TODO el plano merchant: el login es email+password sin indicar
  // merchant, así que no puede haber dos usuarios con el mismo email.
  email:        { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  name:         { type: String, required: true },

  // ── Rol v1 (fijo) ──────────────────────────────────────────
  role: {
    type: String,
    enum: ['merchant_admin', 'merchant_operator', 'merchant_viewer'],
    default: 'merchant_viewer',
    required: true,
  },

  // ── Estado ─────────────────────────────────────────────────
  active: { type: Boolean, default: true },

  // ── Password temporal / cambio obligatorio en el primer login ──
  // No hay infraestructura de email: el alta genera una password temporal que se
  // muestra UNA vez, y el usuario está obligado a cambiarla en el primer login.
  // Mientras siga a true, el portal bloquea todo salvo /portal/auth/change-password.
  mustChangePassword: { type: Boolean, default: true },

  // ── Puente a jerarquía (Fase 4 — permisos por nodo). Dormido en v1. ──
  // Apunta a un nodo del árbol (HierarchyNode). El campo existe para no rehacer el
  // modelo cuando se implemente la asignación de usuarios a nodos concretos.
  hierarchyNodeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'HierarchyNode',
    default: null,
  },

  // ── Auditoría ──────────────────────────────────────────────
  createdBy:   { type: String, default: null },  // email de quien lo creó (superadmin interno o merchant_admin)
  lastLoginAt: { type: Date,   default: null },
  lastLoginIp: { type: String, default: null },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// Índice compuesto: sirve las consultas por merchant (listado) y por (merchant, rol).
merchantUserSchema.index({ merchantId: 1, role: 1 });

merchantUserSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.models.MerchantUser ||
  mongoose.model('MerchantUser', merchantUserSchema);
