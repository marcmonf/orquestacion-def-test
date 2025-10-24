// src/models/TraceLog.js
'use strict';

const mongoose = require('mongoose');

/**
 * Conexión separada para trazas.
 * - Usa MONGO_LOG_URI si existe; si no, cae en MONGO_URI (safe fallback).
 * - No interfiere con la conexión principal.
 */
const LOG_URI = process.env.MONGO_LOG_URI || process.env.MONGO_URI;
if (!LOG_URI) {
  // No tiramos el proceso: el logger se degradará a consola
  // eslint-disable-next-line no-console
  console.warn('⚠️ [WARN] MONGO_LOG_URI/MONGO_URI no definido: TraceLog usará sólo consola.');
}

let conn = null;
try {
  conn = LOG_URI
    ? mongoose.createConnection(LOG_URI, {
        useNewUrlParser: true,
        useUnifiedTopology: true,
        serverSelectionTimeoutMS: 5000,
        maxPoolSize: 3,
      })
    : null;
} catch (e) {
  // eslint-disable-next-line no-console
  console.warn('⚠️ [WARN] No se pudo crear conexión de trazas:', e.message);
  conn = null;
}

const TraceLogSchema = new mongoose.Schema(
  {
    traceId: { type: String, index: true },        // correlación general
    requestId: { type: String, index: true },      // correlación por request
    sessionId: { type: String, index: true },      // si aplica (cliente/iFrame)
    paymentId: { type: String, index: true },      // correlación por pago
    merchantId: { type: String, index: true },

    level: { type: String, enum: ['error','warning','info','debug','trace'], index: true },
    component: { type: String, default: 'app' },   // p.ej. 'paymentsController','orchestrator','acquirer:xyz'
    event: { type: String },                       // p.ej. 'CAPTURE.REQUEST','CAPTURE.RESPONSE','ROUTING.DECISION'
    message: { type: String },

    data: { type: Object },                        // payload seguro (sin PANs ni datos PCI/GDPR)
    spanId: { type: String },
    parentSpanId: { type: String },
    ip: { type: String },
    userAgent: { type: String },
  },
  { timestamps: true, minimize: false }
);

TraceLogSchema.index({ createdAt: -1 });
TraceLogSchema.index({ paymentId: 1, createdAt: -1 });
TraceLogSchema.index({ merchantId: 1, createdAt: -1, level: 1 });

const TraceLog = conn ? conn.model('TraceLog', TraceLogSchema, 'tracelogs') : null;

module.exports = {
  TraceLog,
  isEnabled: !!conn,
};
