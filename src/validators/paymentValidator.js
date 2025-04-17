const Joi = require('joi');

const paymentSchema = Joi.object({
  paymentId: Joi.string().required(),
  merchantId: Joi.string().required(),
  amount: Joi.number().positive().required(),
  currency: Joi.string().length(3).required(),
  method: Joi.string().valid('card', 'apm', 'bizum', 'blik', 'mbway').required(),
  token: Joi.string().optional(),
  cardNumber: Joi.string().creditCard().optional(),
  expiry: Joi.string().optional(),
  phone: Joi.string().pattern(/^\d{9}$/).optional(),
  status: Joi.string().valid('pending', 'approved', 'declined').optional(),
  authCode: Joi.string().optional(),
  processor: Joi.string().optional(),
  callbackUrl: Joi.string().uri().optional()
});

module.exports = paymentSchema;
