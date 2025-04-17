const Joi = require('joi');

const paymentSchema = Joi.object({
  paymentId: Joi.string().required(),
  merchantId: Joi.string().required(),
  amount: Joi.number().positive().required(),
  currency: Joi.string().length(3).required(),
  method: Joi.string().valid('card', 'apm').required(),
  token: Joi.string().optional(), // ← si el merchant quiere pagar con token
  cardNumber: Joi.string().creditCard().optional(), // ← si lo hace directamente con PAN
  expiry: Joi.string().optional(),
  status: Joi.string().valid('pending', 'approved', 'declined').optional(),
  authCode: Joi.string().optional(),
  processor: Joi.string().optional()
});

module.exports = paymentSchema;
