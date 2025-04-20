// src/validators/tokenValidator.js
const Joi = require('joi');

const currentYear = new Date().getFullYear();

const tokenSchema = Joi.object({
  cardNumber: Joi.string().creditCard().required(),

  expiryMonth: Joi.string()
    .pattern(/^(0[1-9]|1[0-2])$/)
    .required(),

  expiryYear: Joi.string()
    .pattern(/^\d{4}$/)
    .custom((value, helpers) => {
      if (parseInt(value) < currentYear) {
        return helpers.error('expiryYear.tooEarly', { currentYear });
      }
      return value;
    })
    .required(),

  cvv: Joi.string()
    .pattern(/^\d{3,4}$/)
    .required(),

  cardholderName: Joi.string()
    .min(2)
    .max(64)
    .required()
});

module.exports = tokenSchema;
