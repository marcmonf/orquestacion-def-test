const Joi = require('joi');

const transactionSchema = Joi.object({
  amount: Joi.number().positive().required(),
  currency: Joi.string().length(3).required(),
  method: Joi.string().required(), // Ej: card, bizum, blik, etc.
  status: Joi.string().valid('approved', 'declined', 'pending').required(),
  merchantId: Joi.string().required(),
  userId: Joi.string().optional(),
  reference: Joi.string().optional()
});

module.exports = transactionSchema;
