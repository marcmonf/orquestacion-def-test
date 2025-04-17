const Joi = require('joi');

const paymentSchema = Joi.object({
  paymentId: Joi.string().required(),
  merchantId: Joi.string().required(),
  amount: Joi.number().positive().required(),
  currency: Joi.string().length(3).required(),
  method: Joi.string().required(), // Acepta 'card' o cualquier APM (paypal, blik, twint, etc.)
  token: Joi.string().optional(), // Para pagos tokenizados
  cardNumber: Joi.string().creditCard().optional(), // Para pagos con PAN directo
  expiry: Joi.string().optional(),
  status: Joi.string().valid('pending', 'approved', 'declined').optional(),
  authCode: Joi.string().optional(),
  processor: Joi.string().optional()
}).custom((value, helpers) => {
  // Si method es "card", se espera que haya token o cardNumber
  if (value.method === 'card' && !value.token && !value.cardNumber) {
    return helpers.message('Para pagos con tarjeta se requiere token o cardNumber');
  }

  return value;
});

module.exports = paymentSchema;
