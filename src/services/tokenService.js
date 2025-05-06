const crypto = require('crypto');
const Token = require('../models/Token');
const logger = require('../utils/logger');

const generateToken = () => {
  return crypto.randomBytes(16).toString('hex');
};

const createTokenForCard = async ({ cardNumber, cardholderName, expiryMonth, expiryYear, cvv }) => {
  try {
    const token = generateToken();

    const newToken = new Token({
      token,
      cardNumber,      // ya debes tener esto cifrado antes de guardar si quieres cumplir PCI DSS
      cardholderName,
      expiryMonth,
      expiryYear,
      cvv              // opcional: eliminar tras validación si no necesitas guardarlo
    });

    await newToken.save();
    logger.info('Token generado automáticamente desde CIT', { token });

    return token;
  } catch (error) {
    logger.error('Error generando token automático', { error: error.message });
    throw new Error('token.creation.error');
  }
};

module.exports = {
  createTokenForCard
};
