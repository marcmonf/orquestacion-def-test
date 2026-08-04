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

/* Capture acepta DOS grafías para el importe:
 *   - amountOfMoney: { amount, currencyCode }   ← CANÓNICA (igual que refund y cancel)
 *   - amount: <entero en céntimos>              ← LEGADO, se mantiene por compatibilidad
 * Hasta el 4 ago 2026 solo existía la segunda, mientras refund y cancel usaban
 * la primera: mismo concepto con dos formas en endpoints hermanos. No rompía
 * nada, pero confundía a quien integrase. Si se mandan las dos y no coinciden,
 * el controlador responde 400 en vez de elegir una en silencio.
 * Si no se manda ninguna, se captura el importe pendiente completo.
 */
const captureSchema = Joi.object({
  amountOfMoney: Joi.object({
    amount: Joi.number().integer().positive().required(),
    currencyCode: currency.optional()
  }).optional(),
  amount: Joi.number().integer().positive().optional(), // legado
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
  }).optional(), // si falta, reembolsamos el importe reembolsable restante completo
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

/* ========= Exportación =========
 * TRAMPA RETIRADA (4 ago 2026). Este bloque hacía:
 *
 *     module.exports = paymentSchema;          // un objeto Joi
 *     module.exports.validate = validate;      // ← MACHACA paymentSchema.validate
 *
 * Es decir, le sobrescribía a la instancia de Joi su propio método `.validate`
 * con el helper de middleware de este módulo. Consecuencia: cualquier código
 * que hiciera `paymentSchema.validate(obj)` recibía una FUNCIÓN en vez de un
 * resultado de validación, y su `{ error }` era SIEMPRE `undefined`, así que
 * no rechazaba nada — en silencio. Eso fue exactamente lo que dejó pasar todo
 * en el stack `/apms` retirado el 16 jul 2026 (ver DEV-LOG §4).
 *
 * La víctima ya no existe, pero la trampa seguía armada para el siguiente que
 * escribiera `require('paymentValidator').validate(obj)` esperando Joi.
 * Ahora se exporta un objeto plano con nombres explícitos y ningún schema
 * mutado. Único consumidor: src/routes/payments.js, que ya destructuraba
 * correctamente — el cambio no le afecta.
 */
module.exports = {
  paymentSchema,
  captureSchema,
  refundSchema,
  cancelSchema,
  validate,
};
