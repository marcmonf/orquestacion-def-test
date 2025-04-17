const Joi = require('joi');

const paymentSchema = Joi.object({
  paymentId: Joi.string().required(),
  merchantId: Joi.string().required(),
  amount: Joi.number().positive().required(),
  currency: Joi.string().length(3).required(),
  method: Joi.string().valid('card', 'paypal', 'transfer').required(),
  status: Joi.string().valid('pending', 'approved', 'declined').optional(),
  authCode: Joi.string().optional(),
  processor: Joi.string().optional()
});

module.exports = paymentSchema;
