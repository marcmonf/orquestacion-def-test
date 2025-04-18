const Joi = require('joi');

const transactionQuerySchema = Joi.object({
  merchantId: Joi.string().optional(),
  status: Joi.string().valid('approved', 'declined', 'pending').optional(),
  method: Joi.string().optional(),
  currency: Joi.string().length(3).optional(),
  processor: Joi.string().optional(),
  fromDate: Joi.date().iso().optional(),
  toDate: Joi.date().iso().optional(),
  page: Joi.number().integer().min(1).optional(),
  limit: Joi.number().integer().min(1).optional()
});

const validateTransactionQuery = (req, res, next) => {
  const { error } = transactionQuerySchema.validate(req.query);
  if (error) {
    return res.status(400).json({ error: error.details[0].message });
  }
  next();
};

module.exports = validateTransactionQuery;
