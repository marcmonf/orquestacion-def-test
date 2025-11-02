// src/validators/transactionValidator.js
'use strict';
const Joi = require('joi');

const currentYear = new Date().getFullYear();

const transactionSchema = Joi.object({
  paymentId: Joi.forbidden(),

  merchantId: Joi.string().required().messages({
    'any.required': 'transaction.invalid.merchantId'
  }),

  amount: Joi.number().positive().required().messages({
    'number.base': 'transaction.invalid.amount',
    'number.positive': 'transaction.invalid.amount',
    'any.required': 'transaction.invalid.amount'
  }),

  currency: Joi.string().length(3).uppercase().required().messages({
    'string.length': 'transaction.invalid.currency',
    'any.required': 'transaction.invalid.currency'
  }),

  method: Joi.string()
    .valid('card','apm','applepay','googlepay','pix','mbway','bizum')
    .required()
    .messages({ 'any.only': 'transaction.invalid.method', 'any.required': 'transaction.invalid.method' }),

  // ---- Datos de tarjeta (cuando se usa tarjeta física) ----
  cardholderName: Joi.string().min(2).max(64).optional(),
  cardNumber: Joi.string().pattern(/^\d{13,19}$/).optional()
    .messages({ 'string.pattern.base': 'transaction.invalid.cardNumber' }),
  cvv: Joi.string().pattern(/^\d{3,4}$/).optional()
    .messages({ 'string.pattern.base': 'transaction.invalid.cvv' }),
  expiryMonth: Joi.string().pattern(/^(0[1-9]|1[0-2])$/).optional()
    .messages({ 'string.pattern.base': 'transaction.invalid.expiryMonth' }),
  expiryYear: Joi.string().pattern(/^\d{4}$/).optional().custom((value, helpers) => {
      if (parseInt(value, 10) < currentYear) return helpers.error('transaction.invalid.expiryYear.tooLow');
      return value;
    }).messages({
      'string.pattern.base': 'transaction.invalid.expiryYear',
      'transaction.invalid.expiryYear.tooLow': 'transaction.invalid.expiryYear.tooLow'
    }),

  // Apple/Google Pay
  paymentData: Joi.when('method', {
    is: Joi.valid('applepay','googlepay'),
    then: Joi.required().messages({ 'any.required': 'transaction.invalid.paymentData.required' }),
    otherwise: Joi.optional()
  }),

  // Recurrencia
  transactionType: Joi.string().valid('CIT','MIT').default('CIT'),
  isRecurring: Joi.boolean().optional(),
  token: Joi.string().optional(),      // permitido siempre; requerido solo en MIT:
  recurrenceId: Joi.string().optional(),

  // Reglas MIT: si es MIT, token y recurrenceId son obligatorios
  // (comprobación cruzada)
  // Usamos custom para validar dependencias complejas:
  //   - method=card ⇒ o token o (cardNumber+cvv+expiryMonth+expiryYear+cardholderName)
  //   - transactionType=MIT ⇒ token y recurrenceId requeridos
  //   - apple/google pay ⇒ paymentData requerido (ya validado arriba)
  //   - captureNow opcional (para single-message SALE)
  // APMs específicos
  phone: Joi.when('method', {
    is: Joi.valid('mbway','bizum'),
    then: Joi.string().pattern(/^\+?\d{8,15}$/).required()
      .messages({ 'string.pattern.base': 'transaction.invalid.phone' }),
    otherwise: Joi.optional()
  }),

  // URLs
  returnUrl: Joi.string().uri().optional().messages({ 'string.uri': 'transaction.invalid.returnUrl' }),
  callbackUrl: Joi.string().uri().optional().messages({ 'string.uri': 'transaction.invalid.callbackUrl' }),

  // Opcionales
  cardScheme: Joi.string().valid('visa','mastercard','amex','maestro','discover','diners','jcb').optional(),
  status: Joi.string().valid('approved','declined','pending','captured').optional(),
  userId: Joi.string().optional(),
  reference: Joi.string().optional(),

  // Single-message SALE
  captureNow: Joi.boolean().optional(),

  // Hospitality opcional
  reservationId: Joi.string().optional(),
  guestName: Joi.string().optional(),
  checkInDate: Joi.date().optional(),
  checkOutDate: Joi.date().optional(),
  roomType: Joi.string().optional(),
  rateCode: Joi.string().optional(),
  channel: Joi.string().optional(),
  folioNumber: Joi.string().optional()
})
.custom((value, helpers) => {
  // MIT ⇒ token + recurrenceId obligatorios
  if (value.transactionType === 'MIT') {
    if (!value.token) {
      return helpers.error('any.custom', { message: 'transaction.invalid.token.required' });
    }
    if (!value.recurrenceId) {
      return helpers.error('any.custom', { message: 'transaction.invalid.recurrenceId.required' });
    }
  }

  // method=card ⇒ token OR full card data
  if (value.method === 'card') {
    const hasToken = !!value.token;
    const hasFullCard =
      !!value.cardNumber && !!value.cvv && !!value.expiryMonth && !!value.expiryYear && !!value.cardholderName;

    if (!hasToken && !hasFullCard) {
      return helpers.error('any.custom', { message: 'transaction.card.missing.credentials' });
    }
  }

  return value;
})
.prefs({ allowUnknown: false });

module.exports = transactionSchema;
