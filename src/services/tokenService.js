// src/services/tokenService.js
const crypto = require('crypto');
const Token = require('../models/Token');
const logger = require('../utils/logger');

// Función para generar un token aleatorio
const generateToken = () => {
  return crypto.randomBytes(16).toString('hex');
};

// Función para obtener los últimos 4 dígitos del PAN
const getCardLast4 = (cardNumber) => {
  return cardNumber.slice(-4);
};

// Función para obtener el BIN (primeros 6 dígitos)
const getCardBin = (cardNumber) => {
  return cardNumber.slice(0, 6);
};

// Función para cifrar el PAN con AES-256 (si deseas almacenarlo)
const encryptPan = (cardNumber) => {
  const key = process.env.PAN_SECRET_KEY;
  const iv = process.env.PAN_IV;

  if (!key || key.length !== 32) {
    throw new Error('PAN_SECRET_KEY debe tener 32 caracteres');
  }

  if (!iv || iv.length !== 16) {
    throw new Error('PAN_IV debe tener 16 caracteres');
  }

  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(key), Buffer.from(iv));
  let encrypted = cipher.update(cardNumber, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return encrypted;
};

// Función principal para crear y guardar un token
const createTokenForCard = async ({ cardNumber, cardholderName, expiryMonth, expiryYear, cvv }) => {
  try {
    if (!cardNumber || !cvv) {
      throw new Error('token.creation.error');
    }

    // ✅ Validación reforzada del PAN antes de cifrar
    if (!/^\d{13,19}$/.test(cardNumber)) {
      logger.warn('PAN inválido en formato', { cardNumber });
      throw new Error('token.invalid.cardNumber');
    }

    const token = generateToken();

    const newToken = new Token({
      token,
      pan: encryptPan(cardNumber), // PAN cifrado
      last4: getCardLast4(cardNumber),
      bin: getCardBin(cardNumber),
      cardholderName,
      expiryMonth,
      expiryYear
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
