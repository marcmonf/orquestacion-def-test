const Token = require('../models/Token');
const crypto = require('crypto');
const tokenSchema = require('../validators/tokenValidator');
const logger = require('../utils/logger');

// Función auxiliar para generar un token aleatorio
const generateToken = () => crypto.randomBytes(16).toString('hex');

// POST /tokens - Tokenizar tarjeta
const tokenizeCard = async (req, res) => {
  const { error } = tokenSchema.validate(req.body);
  if (error) {
    logger.warn('Validación fallida en tokenización', { details: error.details[0].message });
    return res.status(400).json({ error: error.details[0].message });
  }

  const { cardNumber, expiryMonth, expiryYear, cardholderName } = req.body;

  try {
    const token = generateToken();
    const expiry = `${expiryMonth}/${expiryYear}`;
    const newToken = new Token({
      token,
      pan: cardNumber,
      expiry,
      cardholderName
    });

    await newToken.save();

    logger.info('Tarjeta tokenizada correctamente', { token });
    return res.status(201).json({ token });
  } catch (err) {
    logger.error('Error al tokenizar tarjeta', { error: err.message });
    return res.status(500).json({ error: 'Error interno al tokenizar' });
  }
};

// GET /tokens/:token - Obtener datos de la tarjeta
const getCardData = async (req, res) => {
  const { token } = req.params;

  try {
    const record = await Token.findOne({ token });
    if (!record) {
      logger.warn('Token no encontrado', { token });
      return res.status(404).json({ error: 'Token no encontrado' });
    }

    logger.info('Token consultado correctamente', { token });
    return res.status(200).json({
      pan: record.pan,
      expiry: record.expiry,
      cardholderName: record.cardholderName // ← Solo si quieres incluirlo
    });
  } catch (err) {
    logger.error('Error al recuperar datos del token', { error: err.message });
    return res.status(500).json({ error: 'Error interno' });
  }
};

module.exports = {
  tokenizeCard,
  getCardData
};
