// src/models/BackofficeUser.js
'use strict';
const mongoose = require('mongoose');

const backofficeUserSchema = new mongoose.Schema({
  // Identidad
  email:        { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  name:         { type: String, required: true },

  // Rol: superadmin > admin > operator > viewer
  role: {
    type: String,
    enum: ['superadmin', 'admin', 'operator', 'viewer'],
    default: 'viewer',
    required: true
  },

  // Scope de acceso a merchants
  // ['all'] = acceso total | ['demo-merchant', 'inditex-es'] = solo esos merchants
  merchantScope: {
    type: [String],
    default: ['all']
  },

  // Estado
  active:       { type: Boolean, default: true },
  createdBy:    { type: String, default: null },   // email del superadmin que lo creó
  lastLoginAt:  { type: Date,   default: null },
  lastLoginIp:  { type: String, default: null },

  // Reset de contraseña (sin email: token de un solo uso)
  resetToken:       { type: String, default: null },
  resetTokenExpiry: { type: Date,   default: null },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

backofficeUserSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

// Índice para búsqueda rápida por merchantScope
backofficeUserSchema.index({ merchantScope: 1 });
backofficeUserSchema.index({ role: 1 });

module.exports = mongoose.models.BackofficeUser ||
  mongoose.model('BackofficeUser', backofficeUserSchema);
