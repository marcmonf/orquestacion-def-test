// src/services/tokenService.js
const crypto = require('crypto');
const Token = require('../models/Token');
const logger = require('../utils/logger');

// Clave secreta de cifrado (debe estar definida como variable de entorno segura)
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'default_key_32_bytes_long!'; // 32 bytes para AES-256
const IV_LENGTH = 16; // AES block size

function encrypt(text) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

const generateToken = () => {
  return crypto.randomBytes(16).toString('hex');
};

const createTokenForCard = async ({ cardNumber, cardholderName, expiryMonth, expiryYear, cvv }) => {
  try {
    const token = generateToken();

    const encryptedPan = encrypt(cardNumber);
    const encryptedCvv = cvv ? encrypt(cvv) : undefined;
    const last4 = cardNumber.slice(-4);
    const bin = cardNumber.slice(0, 6);

    const newToken = new Token({
      token,
      pan: encryptedPan,
      last4,
      bin,
      cardholderName,
      expiryMonth,
      expiryYear,
      cvv: encryptedCvv
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
