const Joi = require('joi');

const tokenSchema = Joi.object({
  cardNumber: Joi.string().creditCard().required(),
  expiryMonth: Joi.string().length(2).required(),
  expiryYear: Joi.string().length(4).required(),
  cvv: Joi.string().length(3).required()
});

module.exports = tokenSchema;
