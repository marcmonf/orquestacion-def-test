// src/tokens/tokenController.js
const Token = require('../models/Token');
const crypto = require('crypto');
const tokenSchema = require('../validators/tokenValidator');
const { encryptPan } = require('../utils/cryptoUtils');
const { isValidPanAndCvv } = require('../utils/cardUtils');
const logger = require('../utils/logger');

const generateToken = () => crypto.randomBytes(16).toString('hex');

const tokenizeCard = async (req, res) => {
  const { error } = tokenSchema.validate(req.body);
  if (error) {
    return res.status(400).json({
      success: false,
      message: res.getMessage(error.details[0].message)
    });
  }

  const { cardNumber, expiryMonth, expiryYear, cardholderName, cvv } = req.body;

  if (!isValidPanAndCvv(cardNumber, cvv)) {
    return res.status(400).json({
      success: false,
      message: res.getMessage('token.invalid.cardNumberOrCvv')
    });
  }

  try {
    const token = generateToken();
    const encryptedPan = encryptPan(cardNumber);

    const bin = cardNumber.slice(0, 8); // Usamos BIN de 8 dígitos
    const last4 = cardNumber.slice(-4);

    const newToken = new Token({
      token,
      pan: encryptedPan,
      expiryMonth,
      expiryYear,
      cardholderName,
      bin,
      last4
    });

    await newToken.save();

    delete req.body.cvv;

    logger.info('Token generado correctamente sin almacenar CVV', {
      token,
      endpoint: req.originalUrl,
      method: req.method,
      ip: req.ip,
      timestamp: new Date().toISOString()
    });

    return res.status(201).json({
      success: true,
      token,
      message: res.getMessage('token.created')
    });
  } catch (err) {
    logger.error(`Error al tokenizar tarjeta: ${err.message}`, {
      stack: err.stack,
      timestamp: new Date().toISOString()
    });
    return res.status(500).json({
      success: false,
      message: res.getMessage('token.error')
    });
  }
};

module.exports = { tokenizeCard };
