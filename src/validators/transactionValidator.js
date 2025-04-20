const Joi = require('joi');

const transactionSchema = Joi.object({
  paymentId: Joi.string().optional(),

  amount: Joi.number().positive().required()
    .custom((value, helpers) => {
      if (typeof value !== 'number') {
        return helpers.error('transaction.amount.base');
      }
      if (value <= 0) {
        return helpers.error('transaction.amount.positive');
      }
      return value;
    }),

  currency: Joi.string().length(3).required()
    .custom((value, helpers) => {
      if (typeof value !== 'string') {
        return helpers.error('transaction.currency.base');
      }
      if (value.length !== 3) {
        return helpers.error('transaction.currency.length');
      }
      return value;
    }),

  method: Joi.string().required()
    .custom((value, helpers) => {
      if (typeof value !== 'string') {
        return helpers.error('transaction.method.base');
      }
      return value;
    }),

  status: Joi.string().valid('approved', 'declined', 'pending').required()
    .custom((value, helpers) => {
      const valid = ['approved', 'declined', 'pending'];
      if (!valid.includes(value)) {
        return helpers.error('transaction.status.only');
      }
      return value;
    }),

  merchantId: Joi.string().required()
    .custom((value, helpers) => {
      if (typeof value !== 'string') {
        return helpers.error('transaction.merchantId.base');
      }
      return value;
    }),

  userId: Joi.string().optional(),
  reference: Joi.string().optional(),

  cardholderName: Joi.string().min(2).max(64).required()
    .custom((value, helpers) => {
      if (typeof value !== 'string') {
        return helpers.error('transaction.cardholderName.base');
      }
      if (value.length < 2) {
        return helpers.error('transaction.cardholderName.min');
      }
      if (value.length > 64) {
        return helpers.error('transaction.cardholderName.max');
      }
      return value;
    }),

  expiryMonth: Joi.string().pattern(/^(0[1-9]|1[0-2])$/).required()
    .custom((value, helpers) => {
      if (!/^(0[1-9]|1[0-2])$/.test(value)) {
        return helpers.error('transaction.expiryMonth.pattern');
      }
      return value;
    }),

  expiryYear: Joi.string().pattern(/^\d{4}$/).required()
    .custom((value, helpers) => {
      const currentYear = new Date().getFullYear();
      if (!/^\d{4}$/.test(value)) {
        return helpers.error('transaction.expiryYear.pattern');
      }
      if (parseInt(value) < currentYear) {
        return helpers.error('transaction.expiryYear.invalid');
      }
      return value;
    }),
});

module.exports = transactionSchema;
