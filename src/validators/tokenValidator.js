const Joi = require('joi');

const currentYear = new Date().getFullYear();

const tokenSchema = Joi.object({
  cardNumber: Joi.string()
    .creditCard()
    .required()
    .messages({
      'string.creditCard': 'token.invalid.cardNumber',
      'any.required': 'token.invalid.cardNumber'
    }),

  expiryMonth: Joi.string()
    .pattern(/^(0[1-9]|1[0-2])$/)
    .required()
    .messages({
      'string.pattern.base': 'token.invalid.expiryMonth',
      'any.required': 'token.invalid.expiryMonth'
    }),

  expiryYear: Joi.string()
    .pattern(/^\d{4}$/)
    .required()
    .custom((value, helpers) => {
      if (parseInt(value) < currentYear) {
        return helpers.error('token.invalid.expiryYear.tooLow');
      }
      return value;
    })
    .messages({
      'string.pattern.base': 'token.invalid.expiryYear',
      'any.required': 'token.invalid.expiryYear'
    }),

  cvv: Joi.string()
    .pattern(/^\d{3,4}$/)
    .required()
    .messages({
      'string.pattern.base': 'token.invalid.cvv',
      'any.required': 'token.invalid.cvv'
    }),

  cardholderName: Joi.string()
    .min(2)
    .max(64)
    .required()
    .messages({
      'string.min': 'token.invalid.cardholderName.tooShort',
      'string.max': 'token.invalid.cardholderName.tooLong',
      'any.required': 'token.invalid.cardholderName.required'
    })
});

module.exports = tokenSchema;
