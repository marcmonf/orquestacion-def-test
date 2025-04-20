const Joi = require('joi');

const transactionSchema = Joi.object({
  paymentId: Joi.string().optional(),
  amount: Joi.number().positive().required().messages({
    'number.base': (ctx) => ctx?.prefs?.getMessage?.('transaction.amount.base'),
    'number.positive': (ctx) => ctx?.prefs?.getMessage?.('transaction.amount.positive'),
    'any.required': (ctx) => ctx?.prefs?.getMessage?.('transaction.amount.required'),
  }),
  currency: Joi.string().length(3).required().messages({
    'string.base': (ctx) => ctx?.prefs?.getMessage?.('transaction.currency.base'),
    'string.length': (ctx) => ctx?.prefs?.getMessage?.('transaction.currency.length'),
    'any.required': (ctx) => ctx?.prefs?.getMessage?.('transaction.currency.required'),
  }),
  method: Joi.string().required().messages({
    'string.base': (ctx) => ctx?.prefs?.getMessage?.('transaction.method.base'),
    'any.required': (ctx) => ctx?.prefs?.getMessage?.('transaction.method.required'),
  }),
  status: Joi.string().valid('approved', 'declined', 'pending').required().messages({
    'any.only': (ctx) => ctx?.prefs?.getMessage?.('transaction.status.only'),
    'any.required': (ctx) => ctx?.prefs?.getMessage?.('transaction.status.required'),
  }),
  merchantId: Joi.string().required().messages({
    'string.base': (ctx) => ctx?.prefs?.getMessage?.('transaction.merchantId.base'),
    'any.required': (ctx) => ctx?.prefs?.getMessage?.('transaction.merchantId.required'),
  }),
  userId: Joi.string().optional(),

  reference: Joi.string().optional(),

  cardholderName: Joi.string().min(2).max(64).required().messages({
    'string.base': (ctx) => ctx?.prefs?.getMessage?.('transaction.cardholderName.base'),
    'string.min': (ctx) => ctx?.prefs?.getMessage?.('transaction.cardholderName.min'),
    'string.max': (ctx) => ctx?.prefs?.getMessage?.('transaction.cardholderName.max'),
    'any.required': (ctx) => ctx?.prefs?.getMessage?.('transaction.cardholderName.required'),
  }),

  expiryMonth: Joi.string()
    .pattern(/^(0[1-9]|1[0-2])$/)
    .required()
    .messages({
      'string.pattern.base': (ctx) => ctx?.prefs?.getMessage?.('transaction.expiryMonth.pattern'),
      'any.required': (ctx) => ctx?.prefs?.getMessage?.('transaction.expiryMonth.required'),
    }),

  expiryYear: Joi.string()
    .pattern(/^\d{4}$/)
    .required()
    .messages({
      'string.pattern.base': (ctx) => ctx?.prefs?.getMessage?.('transaction.expiryYear.pattern'),
      'any.required': (ctx) => ctx?.prefs?.getMessage?.('transaction.expiryYear.required'),
    }),
});

module.exports = transactionSchema;
