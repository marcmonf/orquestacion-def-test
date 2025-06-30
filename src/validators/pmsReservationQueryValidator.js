const Joi = require('joi');

const getMessage = require('../i18n/getMessage');

const schema = Joi.object({
  merchantId: Joi.string().optional(),
  status: Joi.string().valid('pending', 'confirmed', 'cancelled').optional(),
  from: Joi.date().iso().optional(),
  to: Joi.date().iso().optional()
});

function validateReservationQuery(req, res, next) {
  const langHeader = req.headers['accept-language'];
  const lang = langHeader?.split(',')[0]?.split('-')[0]?.trim().toLowerCase() || 'en';

  const { error } = schema.validate(req.query);
  if (error) {
    return res.status(400).json({
      success: false,
      message: getMessage(lang, 'error.invalidQueryParameters'),
      details: error.details.map(d => d.message)
    });
  }

  next();
}

module.exports = validateReservationQuery;
