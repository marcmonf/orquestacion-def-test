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

    const bin = cardNumber.slice(0, 8);
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
      ip: req.ip
    });

    return res.status(201).json({
      success: true,
      token,
      message: res.getMessage('token.created')
    });
  } catch (err) {
    logger.error(`Error al tokenizar tarjeta: ${err.message}`, { stack: err.stack });
    return res.status(500).json({
      success: false,
      message: res.getMessage('token.error')
    });
  }
};

const getCardData = async (req, res) => {
  const { token } = req.params;

  try {
    const record = await Token.findOne({ token });
    if (!record) {
      return res.status(404).json({
        success: false,
        message: res.getMessage('token.not.found')
      });
    }

    return res.status(200).json({
      success: true,
      bin: record.bin,
      last4: record.last4,
      cardholderName: truncateName(record.cardholderName)
    });
  } catch (err) {
    logger.error(`Error al recuperar token: ${err.message}`, { stack: err.stack });
    return res.status(500).json({
      success: false,
      message: res.getMessage('token.error')
    });
  }
};

// Función para truncar el nombre del titular (por privacidad)
const truncateName = (name) => {
  if (!name) return '';
  const parts = name.trim().split(' ');
  const firstName = parts[0];
  return `${firstName[0]}*** ${parts.slice(1).join(' ')}`.trim();
};

module.exports = { tokenizeCard, getCardData };
