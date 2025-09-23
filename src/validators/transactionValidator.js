// src/validators/transactionValidator.js
'use strict';
const Joi = require('joi');

const currentYear = new Date().getFullYear();

// Habilita PAN/CVV solo en desarrollo de pruebas (evita ampliar alcance PCI en prod)
const ALLOW_RAW_PAN = String(process.env.FEATURE_ALLOW_RAW_PAN || '0') === '1';

const transactionSchema = Joi.object({
  paymentId: Joi.forbidden(),

  amount: Joi.number().positive().required().messages({
    'number.base': 'transaction.invalid.amount',
    'number.positive': 'transaction.invalid.amount',
    'any.required': 'transaction.invalid.amount'
  }),

  currency: Joi.string().length(3).uppercase().required().when('method', {
    is: 'pix',
    then: Joi.valid('BRL').required().messages({
      'any.only': 'transaction.invalid.currency.pix.required',
      'any.required': 'transaction.invalid.currency.pix.required'
    })
  }).messages({
    'string.base': 'transaction.invalid.currency',
    'string.length': 'transaction.invalid.currency',
    'any.required': 'transaction.invalid.currency'
  }),

  method: Joi.string().required().messages({
    'string.base': 'transaction.invalid.method',
    'any.required': 'transaction.invalid.method'
  }),

  cardScheme: Joi.string()
    .valid('visa','mastercard','amex','maestro','discover','diners','jcb')
    .optional()
    .messages({ 'any.only': 'transaction.invalid.cardScheme' }),

  status: Joi.string().valid('approved', 'declined', 'pending').optional(),

  merchantId: Joi.string().required().messages({
    'string.base': 'transaction.invalid.merchantId',
    'any.required': 'transaction.invalid.merchantId'
  }),

  userId: Joi.string().optional(),
  reference: Joi.string().optional(),

  // ---- Campos de tarjeta (visibles si method=card) ----
  cardholderName: Joi.when('method', {
    is: Joi.valid('card'),
    then: Joi.string().min(2).max(64).required().messages({
      'string.base': 'transaction.invalid.cardholderName',
      'string.min': 'transaction.invalid.cardholderName',
      'string.max': 'transaction.invalid.cardholderName',
      'any.required': 'transaction.invalid.cardholderName'
    }),
    otherwise: Joi.forbidden()
  }),

  expiryMonth: Joi.when('method', {
    is: Joi.valid('card'),
    then: Joi.string().pattern(/^(0[1-9]|1[0-2])$/).required().messages({
      'string.pattern.base': 'transaction.invalid.expiryMonth',
      'any.required': 'transaction.invalid.expiryMonth'
    }),
    otherwise: Joi.forbidden()
  }),

  expiryYear: Joi.when('method', {
    is: Joi.valid('card'),
    then: Joi.string()
      .pattern(/^\d{4}$/)
      .required()
      .custom((value, helpers) => {
        if (parseInt(value, 10) < currentYear) {
          return helpers.error('transaction.invalid.expiryYear.tooLow');
        }
        return value;
      })
      .messages({
        'string.pattern.base': 'transaction.invalid.expiryYear',
        'any.required': 'transaction.invalid.expiryYear',
        'transaction.invalid.expiryYear.tooLow': 'transaction.invalid.expiryYear.tooLow'
      }),
    otherwise: Joi.forbidden()
  }),

  // PAN/CVV condicionados por flag para no ampliar alcance PCI en prod
  cardNumber: Joi.when('method', {
    is: 'card',
    then: ALLOW_RAW_PAN
      ? Joi.string()
          .pattern(/^\d{13,19}$/)
          .when('transactionType', {
            is: 'CIT',
            then: Joi.required(),
            otherwise: Joi.forbidden()
          })
          .messages({
            'string.pattern.base': 'transaction.invalid.cardNumber',
            'any.required': 'transaction.invalid.cardNumber.required'
          })
      : Joi.forbidden().messages({ 'any.unknown': 'cardNumber.not.allowed' }),
    otherwise: Joi.forbidden()
  }),

  cvv: Joi.when('method', {
    is: 'card',
    then: ALLOW_RAW_PAN
      ? Joi.string()
          .pattern(/^\d{3,4}$/)
          .when('transactionType', {
            is: 'CIT',
            then: Joi.required(),
            otherwise: Joi.forbidden()
          })
          .messages({
            'string.pattern.base': 'transaction.invalid.cvv',
            'any.required': 'transaction.invalid.cvv.required'
          })
      : Joi.forbidden().messages({ 'any.unknown': 'cvv.not.allowed' }),
    otherwise: Joi.forbidden()
  }),

  // Apple/Google Pay requieren paymentData cuando method es applepay/googlepay
  paymentData: Joi.when('method', {
    is: Joi.valid('applepay', 'googlepay'),
    then: Joi.required().messages({ 'any.required': 'transaction.invalid.paymentData.required' }),
    otherwise: Joi.forbidden()
  }),

  isRecurring: Joi.boolean().optional(),

  recurrenceId: Joi.string().when('transactionType', {
    is: 'MIT',
    then: Joi.required().messages({ 'any.required': 'transaction.invalid.recurrenceId.required' }),
    otherwise: Joi.optional()
  }),

  // Por defecto CIT si no lo envías, para que cardNumber/cvv no queden “prohibidos”
  transactionType: Joi.string().valid('CIT', 'MIT').default('CIT').required().messages({
    'any.only': 'transaction.invalid.transactionType',
    'any.required': 'transaction.invalid.transactionType'
  }),

  token: Joi.string().when('transactionType', {
    is: 'MIT',
    then: Joi.required().messages({ 'any.required': 'transaction.invalid.token.required' }),
    otherwise: Joi.optional()
  }),

  phone: Joi.when('method', {
    is: 'mbway',
    then: Joi.string().pattern(/^\+?\d{8,15}$/).required().messages({
      'string.pattern.base': 'transaction.invalid.phone',
      'any.required': 'transaction.invalid.phone.mbway.required'
    }),
    otherwise: Joi.when('method', {
      is: 'bizum',
      then: Joi.string().pattern(/^\+?\d{8,15}$/).required().messages({
        'string.pattern.base': 'transaction.invalid.phone',
        'any.required': 'transaction.invalid.phone.bizum.required'
      }),
      otherwise: Joi.optional()
    })
  }),

  returnUrl: Joi.string().uri().optional().messages({ 'string.uri': 'transaction.invalid.returnUrl' }),

  // Hospitality-specific (opcionales)
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
