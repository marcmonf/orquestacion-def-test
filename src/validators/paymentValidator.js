// src/validators/paymentValidator.js
'use strict';

const Joi = require('joi');

/* ========= EXISTENTE: no se toca para no romper nada ========= */
const paymentSchema = Joi.object({
  paymentId: Joi.string().required(),
  merchantId: Joi.string().required(),
  amount: Joi.number().positive().required(),
  currency: Joi.string().length(3).required(),
  method: Joi.string().valid('card', 'apm', 'bizum', 'blik', 'mbway').required(),
  token: Joi.string().optional(),
  cardNumber: Joi.string().creditCard().optional(),
  expiry: Joi.string().optional(),
  phone: Joi.string().pattern(/^\d{9}$/).optional(),
  status: Joi.string().valid('pending', 'approved', 'declined').optional(),
  authCode: Joi.string().optional(),
  processor: Joi.string().optional(),
  callbackUrl: Joi.string().uri().optional()
});

/* ========= NUEVO: validaciones para operaciones ========= */
const currency = Joi.string().length(3).uppercase();

const captureSchema = Joi.object({
  amount: Joi.number().integer().positive().optional(), // si falta, capturamos lo pendiente
  isFinal: Joi.boolean().optional(),
  references: Joi.object({
    merchantReference: Joi.string().optional(),
    merchantParameters: Joi.string().optional(),
    operationGroupReference: Joi.string().optional()
  }).optional(),
  operationReferences: Joi.object({
    merchantReference: Joi.string().optional(),
    operationGroupReference: Joi.string().optional()
  }).optional()
}).prefs({ allowUnknown: false });

const refundSchema = Joi.object({
  amountOfMoney: Joi.object({
    amount: Joi.number().integer().positive().required(),
    currencyCode: currency.optional()
  }).required(),
  references: Joi.object({
    merchantReference: Joi.string().optional(),
    merchantParameters: Joi.string().optional(),
    operationGroupReference: Joi.string().optional()
  }).optional(),
  operationReferences: Joi.object({
    merchantReference: Joi.string().optional(),
    operationGroupReference: Joi.string().optional()
  }).optional(),
  reason: Joi.string().optional(),
  omnichannelRefundSpecificInput: Joi.object({
    operatorId: Joi.string().optional()
  }).optional()
}).prefs({ allowUnknown: false });

const cancelSchema = Joi.object({
  amountOfMoney: Joi.object({
    amount: Joi.number().integer().positive().optional(),
    currencyCode: currency.optional()
  }).optional(),
  isFinal: Joi.boolean().optional(),
  operationReferences: Joi.object({
    merchantReference: Joi.string().optional(),
    operationGroupReference: Joi.string().optional()
  }).optional()
}).prefs({ allowUnknown: false });

/* Helper para usar en rutas */
function validate(schema) {
  return (req, res, next) => {
    const { error } = schema.validate(req.body);
    if (!error) return next();
    return res.status(400).json({
      success: false,
      message: error.details?.[0]?.message || 'validation.error'
    });
  };
}

/* ========= Exportación compatible hacia atrás =========
   - module.exports = paymentSchema  (para el uso actual existente)
   - Añadimos propiedades para poder hacer require(...).captureSchema, etc.
====================================================== */
module.exports = paymentSchema;                 // compat backward
module.exports.paymentSchema = paymentSchema;   // acceso explícito si alguien lo necesita
module.exports.captureSchema = captureSchema;
module.exports.refundSchema = refundSchema;
module.exports.cancelSchema = cancelSchema;
module.exports.validate = validate;
