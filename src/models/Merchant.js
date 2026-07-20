// src/models/Merchant.js
//
// MODELO OPERATIVO DE MERCHANT (unificado — M2).
//
// Este es el modelo de trabajo del día a día: identidad del comercio, a dónde
// se le notifica (webhookUrl), con qué secreto se firman sus webhooks salientes
// (signingSecret), qué servicio/plantilla de Paylands le corresponde, branding,
// plan y estado.
//
// Alineación con Paylands (integración simple):
//   - serviceUuid  → campo `service` de POST /payment (UUID del servicio Paylands)
//   - templateUuid → campo `template_uuid` (plantilla/branding de la carta de pago)
//   - webhookUrl   → destino de la notificación saliente de Monetiser al merchant
//   Ambos serviceUuid/templateUuid son OPCIONALES: si un merchant no los define,
//   el sistema hace fallback a las variables globales de entorno
//   (PAYNOPAIN_SERVICE_UUID, etc.). Hoy demo-merchant funciona así.
//
// Relación con MerchantHierarchy (organización corporativa — EN STANDBY):
//   MerchantHierarchy modela la estructura corporativa de un cliente grande
//   (globalGroup → group → branch → region → tienda). No se usa todavía, pero
//   está preparado para clientes enterprise que lo pidan. El puente ya está
//   construido aquí: el campo `hierarchyId` referencia el nodo de jerarquía de
//   este merchant. Hoy queda vacío (dormido); el día que se active la jerarquía,
//   solo hay que empezar a rellenarlo — no se rehace nada.
//   Ver nota "REACTIVAR CUANDO SEA NECESARIO" en src/models/MerchantHierarchy.js
//
const mongoose = require('mongoose');

const brandingSchema = new mongoose.Schema({
  logoUrl:      String,
  primaryColor: String,
  accentColor:  String,
  merchantName: String,
}, { _id: false });

const merchantSchema = new mongoose.Schema({
  // ── Identidad ──────────────────────────────────────────────
  merchantId:   { type: String, required: true, unique: true },
  name:         { type: String },  // nombre comercial, ej: "Inditex S.A."
  merchantName: { type: String },  // (legacy) se mantiene por compatibilidad
  country:      { type: String },  // ISO 3166-1 alpha-2, ej: "ES"

  // ── Plan y estado ──────────────────────────────────────────
  plan: {
    type: String,
    enum: ['free', 'starter', 'growth', 'enterprise'],
    default: 'free',
  },
  status: {
    type: String,
    enum: ['active', 'suspended', 'pending'],
    default: 'active',
  },

  // ── Notificación saliente al merchant ──────────────────────
  webhookUrl:   { type: String },  // URL donde Monetiser notifica los pagos

  // ── Configuración Paylands por-merchant (opcional, fallback a ENV) ──
  serviceUuid:  { type: String },  // → campo `service` de POST /payment
  templateUuid: { type: String },  // → campo `template_uuid` (branding carta de pago)

  // ── Jerarquía de tiendas (M6 Fase 2) ───────────────────────
  // Puntero OPCIONAL al nodo RAÍZ del árbol de este merchant. La pertenencia de
  // cada nodo va por HierarchyNode.merchantId; este campo es solo un atajo a la
  // raíz. Vacío por defecto (no obligatorio). Antes referenciaba el modelo plano
  // MerchantHierarchy (retirado); ahora el árbol vive en HierarchyNode.
  hierarchyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'HierarchyNode',
    default: null,
  },

  // ── Branding (nuevo, anidado) ──────────────────────────────
  branding: { type: brandingSchema, default: () => ({}) },

  // ── Branding (legacy, plano — NO borrar: lo leen iframe/inpage) ──
  logoUrl:      String,
  brandColor:   String,
  accentColor:  String,

  // ── Secretos (NO borrar: hpp.js lee signingSecret||hmacSecret||secret) ──
  signingSecret: String,  // secret para firmar webhooks salientes a este merchant
  hmacSecret:    String,
  secret:        String,

  // ── Backoffice login (legacy — el login real usa BackofficeUser) ──
  email:        { type: String, sparse: true },
  passwordHash: { type: String },

  // ── Timestamps ─────────────────────────────────────────────
  createdAt:    { type: Date, default: Date.now },
  updatedAt:    { type: Date, default: Date.now },
});

// Índice único sparse en email: permite múltiples documentos sin email
merchantSchema.index({ email: 1 }, { unique: true, sparse: true });

// Mantener updatedAt al día en save() y en updates
merchantSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});
merchantSchema.pre('findOneAndUpdate', function (next) {
  this.set({ updatedAt: new Date() });
  next();
});

module.exports =
  mongoose.models.Merchant ||
  mongoose.model('Merchant', merchantSchema);
