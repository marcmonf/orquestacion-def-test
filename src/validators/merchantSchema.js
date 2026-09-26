// src/validators/merchantSchema.js
'use strict';
//
// Validación COMPARTIDA de los datos de un merchant (alta y edición), usada por
// /merchants (X-Admin-Token) y /backoffice/merchants (sesión de superadmin).
// Antes el alta del backoffice no validaba nada: merchantId con espacios o
// barras (rompe las URLs /:merchantId/...), webhookUrl http o hacia la red
// interna, colores/logos arbitrarios que acaban dentro del iFrame de pago.
//
const Joi = require('joi');

// Identificador que viaja en las URLs de la API: seguro para rutas, sin sorpresas.
const merchantId = () => Joi.string().pattern(/^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/)
  .messages({ 'string.pattern.base': 'merchantId: 3-64 caracteres, letras, números, "-" o "_"' });

const httpsUrl  = () => Joi.string().uri({ scheme: ['https'] }).max(2048);
const hexColor  = () => Joi.string().pattern(/^#[0-9a-fA-F]{3,8}$/);
const country   = () => Joi.string().uppercase().pattern(/^[A-Z]{2}$/);

const brandingSchema = Joi.object({
  logoUrl:      httpsUrl().allow('', null),
  primaryColor: hexColor().allow('', null),
  accentColor:  hexColor().allow('', null),
  merchantName: Joi.string().max(120).allow('', null),
});

const common = {
  name:          Joi.string().max(200).allow('', null),
  country:       country().allow('', null),
  plan:          Joi.string().valid('free', 'starter', 'growth', 'enterprise'),
  status:        Joi.string().valid('active', 'suspended', 'pending'),
  webhookUrl:    httpsUrl().allow('', null),
  serviceUuid:   Joi.string().max(64).allow('', null),
  templateUuid:  Joi.string().max(64).allow('', null),
  branding:      brandingSchema,
  // branding plano legacy (compatibilidad)
  logoUrl:       httpsUrl().allow('', null),
  brandColor:    hexColor().allow('', null),
  accentColor:   hexColor().allow('', null),
  hierarchyId:   Joi.string().allow(null),
};

const createSchema = Joi.object({ merchantId: merchantId().required(), ...common });
const updateSchema = Joi.object({ ...common }).min(1);

module.exports = { createSchema, updateSchema, merchantId };
