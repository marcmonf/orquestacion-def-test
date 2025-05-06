// src/validators/transactionValidator.js
const Joi = require('joi');

const currentYear = new Date().getFullYear();

const transactionSchema = Joi.object({
  paymentId: Joi.string().optional(),

  amount: Joi.number()
    .positive()
    .required()
    .messages({
      'number.base': 'transaction.invalid.amount',
      'number.positive': 'transaction.invalid.amount',
      'any.required': 'transaction.invalid.amount'
    }),

  currency: Joi.string()
    .length(3)
    .required()
    .messages({
      'string.base': 'transaction.invalid.currency',
      'string.length': 'transaction.invalid.currency',
      'any.required': 'transaction.invalid.currency'
    }),

  method: Joi.string()
    .required()
    .messages({
      'string.base': 'transaction.invalid.method',
      'any.required': 'transaction.invalid.method'
    }),

  status: Joi.string()
    .valid('approved', 'declined', 'pending')
    .required()
    .messages({
      'any.only': 'transaction.invalid.status',
      'any.required': 'transaction.invalid.status'
    }),

  merchantId: Joi.string()
    .required()
    .messages({
      'string.base': 'transaction.invalid.merchantId',
      'any.required': 'transaction.invalid.merchantId'
    }),

  userId: Joi.string().optional(),
  reference: Joi.string().optional(),

  cardholderName: Joi.string()
    .min(2)
    .max(64)
    .required()
    .messages({
      'string.base': 'transaction.invalid.cardholderName',
      'string.min': 'transaction.invalid.cardholderName',
      'string.max': 'transaction.invalid.cardholderName',
      'any.required': 'transaction.invalid.cardholderName'
    }),

  expiryMonth: Joi.string()
    .pattern(/^(0[1-9]|1[0-2])$/)
    .required()
    .messages({
      'string.pattern.base': 'transaction.invalid.expiryMonth',
      'any.required': 'transaction.invalid.expiryMonth'
    }),

  expiryYear: Joi.string()
    .pattern(/^\d{4}$/)
    .required()
    .custom((value, helpers) => {
      if (parseInt(value) < currentYear) {
        return helpers.error('transaction.invalid.expiryYear.tooLow');
      }
      return value;
    })
    .messages({
      'string.pattern.base': 'transaction.invalid.expiryYear',
      'any.required': 'transaction.invalid.expiryYear'
    }),

  isRecurring: Joi.boolean().optional(),

  recurrenceId: Joi.string().when('transactionType', {
    is: 'CIT',
    then: Joi.when('isRecurring', {
      is: true,
      then: Joi.required().messages({
        'any.required': 'transaction.invalid.recurrenceId.required'
      }),
      otherwise: Joi.optional()
    }),
    otherwise: Joi.when('transactionType', {
      is: 'MIT',
      then: Joi.required().messages({
        'any.required': 'transaction.invalid.recurrenceId.required'
      }),
      otherwise: Joi.optional()
    })
  }),

  transactionType: Joi.string()
    .valid('CIT', 'MIT')
    .required()
    .messages({
      'any.only': 'transaction.invalid.transactionType',
      'any.required': 'transaction.invalid.transactionType'
    }),

  token: Joi.string().when('transactionType', {
    is: 'MIT',
    then: Joi.required().messages({
      'any.required': 'transaction.invalid.token.required'
    }),
    otherwise: Joi.optional()
  })
});

module.exports = transactionSchema;
