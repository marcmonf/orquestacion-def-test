// src/validators/transactionValidator.js
'use strict';
const Joi = require('joi');

const currentYear = new Date().getFullYear();

const transactionSchema = Joi.object({
  paymentId: Joi.forbidden(),

  merchantId: Joi.string().required().messages({
    'any.required': 'transaction.invalid.merchantId'
  }),

  amount: Joi.number().positive().required().messages({
    'number.base': 'transaction.invalid.amount',
    'number.positive': 'transaction.invalid.amount',
    'any.required': 'transaction.invalid.amount'
  }),

  currency: Joi.string().length(3).uppercase().required().messages({
    'string.length': 'transaction.invalid.currency',
    'any.required': 'transaction.invalid.currency'
  }),

  method: Joi.string()
    .valid('card','apm','applepay','googlepay','pix','mbway','bizum')
    .required()
    .messages({ 'any.only': 'transaction.invalid.method', 'any.required': 'transaction.invalid.method' }),

  // ---- Tarjeta: requerido cuando method=card ----
  cardholderName: Joi.when('method', {
    is: 'card',
    then: Joi.string().min(2).max(64).required()
      .messages({ 'any.required': 'transaction.invalid.cardholderName' }),
    otherwise: Joi.forbidden()
  }),

  cardNumber: Joi.when('method', {
    is: 'card',
    then: Joi.string().pattern(/^\d{13,19}$/).required()
      .messages({
        'string.pattern.base': 'transaction.invalid.cardNumber',
        'any.required': 'transaction.invalid.cardNumber.required'
      }),
    otherwise: Joi.forbidden()
  }),

  cvv: Joi.when('method', {
    is: 'card',
    then: Joi.string().pattern(/^\d{3,4}$/).required()
      .messages({
        'string.pattern.base': 'transaction.invalid.cvv',
        'any.required': 'transaction.invalid.cvv.required'
      }),
    otherwise: Joi.forbidden()
  }),

  expiryMonth: Joi.when('method', {
    is: 'card',
    then: Joi.string().pattern(/^(0[1-9]|1[0-2])$/).required()
      .messages({ 'string.pattern.base': 'transaction.invalid.expiryMonth' }),
    otherwise: Joi.forbidden()
  }),

  expiryYear: Joi.when('method', {
    is: 'card',
    then: Joi.string().pattern(/^\d{4}$/).required().custom((value, helpers) => {
      if (parseInt(value, 10) < currentYear) return helpers.error('transaction.invalid.expiryYear.tooLow');
      return value;
    }).messages({
      'string.pattern.base': 'transaction.invalid.expiryYear',
      'transaction.invalid.expiryYear.tooLow': 'transaction.invalid.expiryYear.tooLow'
    }),
    otherwise: Joi.forbidden()
  }),

  // Apple/Google Pay
  paymentData: Joi.when('method', {
    is: Joi.valid('applepay','googlepay'),
    then: Joi.required().messages({ 'any.required': 'transaction.invalid.paymentData.required' }),
    otherwise: Joi.forbidden()
  }),

  // Recurrencia: por defecto CIT, NO requerido
  transactionType: Joi.string().valid('CIT','MIT').default('CIT'),
  isRecurring: Joi.boolean().optional(),
  token: Joi.string().when('transactionType', {
    is: 'MIT', then: Joi.required().messages({ 'any.required': 'transaction.invalid.token.required' }),
    otherwise: Joi.optional()
  }),
  recurrenceId: Joi.string().when('transactionType', {
    is: 'MIT', then: Joi.required().messages({ 'any.required': 'transaction.invalid.recurrenceId.required' }),
    otherwise: Joi.optional()
  }),

  // APMs específicos
  phone: Joi.when('method', {
    is: Joi.valid('mbway','bizum'),
    then: Joi.string().pattern(/^\+?\d{8,15}$/).required()
      .messages({ 'string.pattern.base': 'transaction.invalid.phone' }),
    otherwise: Joi.optional()
  }),

  // URLs opcionales
  returnUrl: Joi.string().uri().optional().messages({ 'string.uri': 'transaction.invalid.returnUrl' }),
  callbackUrl: Joi.string().uri().optional().messages({ 'string.uri': 'transaction.invalid.callbackUrl' }),

  // Opcionales
  cardScheme: Joi.string().valid('visa','mastercard','amex','maestro','discover','diners','jcb').optional(),
  status: Joi.string().valid('approved','declined','pending').optional(),
  userId: Joi.string().optional(),
  reference: Joi.string().optional(),

  // Hospitality opcional
  reservationId: Joi.string().optional(),
  guestName: Joi.string().optional(),
  checkInDate: Joi.date().optional(),
  checkOutDate: Joi.date().optional(),
  roomType: Joi.string().optional(),
  rateCode: Joi.string().optional(),
  channel: Joi.string().optional(),
  folioNumber: Joi.string().optional()
})
.prefs({ allowUnknown: false });

module.exports = transactionSchema;
