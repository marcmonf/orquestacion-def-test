const Joi = require('joi');

const transactionSchema = Joi.object({
  paymentId: Joi.string().optional(),
  amount: Joi.number().positive().required(),
  currency: Joi.string().length(3).required(),
  method: Joi.string().required(), // Ej: card, bizum, blik, etc.
  status: Joi.string().valid('approved', 'declined', 'pending').required(),
  merchantId: Joi.string().required(),
  userId: Joi.string().optional(),
  reference: Joi.string().optional(),
  cardholderName: Joi.string().min(2).required(),
  expiryMonth: Joi.string().pattern(/^(0[1-9]|1[0-2])$/).required(), // 01 a 12
  expiryYear: Joi.string().pattern(/^\d{4}$/).required() // 4 dígitos
});

module.exports = transactionSchema;
