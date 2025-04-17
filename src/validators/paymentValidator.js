const Joi = require('joi');

const paymentSchema = Joi.object({
  paymentId: Joi.string().required(),
  merchantId: Joi.string().required(),
  amount: Joi.number().positive().required(),
  currency: Joi.string().length(3).required(),
  method: Joi.string().required(), // Puede ser 'card', 'blik', 'twint', etc.
  token: Joi.string().optional(),
  cardNumber: Joi.string().creditCard().optional(),
  expiry: Joi.string().optional(),
  status: Joi.string().valid('pending', 'approved', 'declined').optional(),
  authCode: Joi.string().optional(),
  processor: Joi.string().optional(),
  callbackUrl: Joi.string().uri().optional() // <-- añadimos esto
});

module.exports = paymentSchema;
