const Joi = require('joi');

const currentYear = new Date().getFullYear();

const tokenSchema = Joi.object({
  cardNumber: Joi.string().creditCard().required(),

  expiryMonth: Joi.string()
    .pattern(/^(0[1-9]|1[0-2])$/)
    .required()
    .messages({
      'string.pattern.base': 'expiryMonth debe ser un valor entre 01 y 12'
    }),

  expiryYear: Joi.string()
    .pattern(/^\d{4}$/)
    .custom((value, helpers) => {
      if (parseInt(value) < currentYear) {
        return helpers.message(`expiryYear no puede ser menor que ${currentYear}`);
      }
      return value;
    })
    .required(),

  cvv: Joi.string()
    .pattern(/^\d{3,4}$/)
    .required()
    .messages({
      'string.pattern.base': 'cvv debe tener 3 o 4 dígitos'
    }),

  cardholderName: Joi.string()
    .min(2)
    .max(64)
    .required()
    .messages({
      'string.empty': 'cardholderName es obligatorio',
      'string.min': 'cardholderName debe tener al menos 2 caracteres',
      'string.max': 'cardholderName no puede superar los 64 caracteres'
    })
});

module.exports = tokenSchema;
