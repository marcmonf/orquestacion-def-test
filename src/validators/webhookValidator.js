const Joi = require('joi');

const webhookSchema = Joi.object({
  paymentId: Joi.string().required(),
  status: Joi.string().valid('approved', 'declined', 'pending').required(),
  authCode: Joi.string().required(),
  processor: Joi.string().required(),
  timestamp: Joi.date().iso().required()
});

module.exports = webhookSchema;
