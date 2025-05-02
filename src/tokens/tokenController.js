// src/tokens/tokenController.js
const Token = require('../models/Token');
const crypto = require('crypto');
const tokenSchema = require('../validators/tokenValidator');
const { encryptPan, decryptPan } = require('../utils/cryptoUtils');
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
    const bin = cardNumber.slice(0, 6);
    const last4 = cardNumber.slice(-4);

    const newToken = new Token({
      token,
      pan: encryptedPan,
      bin,
      last4,
      expiryMonth,
      expiryYear,
      cardholderName
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

    const decryptedPan = decryptPan(record.pan);

    return res.status(200).json({
      success: true,
      pan: decryptedPan,
      expiryMonth: record.expiryMonth,
      expiryYear: record.expiryYear,
      cardholderName: record.cardholderName
    });
  } catch (err) {
    logger.error(`Error al recuperar token: ${err.message}`, { stack: err.stack });
    return res.status(500).json({
      success: false,
      message: res.getMessage('token.error')
    });
  }
};

module.exports = { tokenizeCard, getCardData };
