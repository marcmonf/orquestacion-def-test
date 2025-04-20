const Token = require('../models/Token');
const crypto = require('crypto');
const tokenSchema = require('../validators/tokenValidator');

// Función auxiliar para generar token aleatorio
const generateToken = () => {
  return crypto.randomBytes(16).toString('hex');
};

const tokenizeCard = async (req, res) => {
  const { error } = tokenSchema.validate(req.body);
  if (error) {
    return res.status(400).json({ error: error.details[0].message });
  }

  const { cardNumber, expiryMonth, expiryYear, cvv, cardholderName } = req.body;

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

    return res.status(201).json({ token });
  } catch (err) {
    console.error('Error al tokenizar tarjeta:', err);
    return res.status(500).json({ error: 'Error interno al tokenizar' });
  }
};

const getCardData = async (req, res) => {
  const { token } = req.params;

  try {
    const record = await Token.findOne({ token });
    if (!record) {
      return res.status(404).json({ error: 'Token no encontrado' });
    }

    return res.status(200).json({
      pan: record.pan,
      expiry: record.expiry,
      cardholderName: record.cardholderName
    });
  } catch (err) {
    console.error('Error al recuperar tarjeta:', err);
    return res.status(500).json({ error: 'Error interno' });
  }
};

module.exports = { tokenizeCard, getCardData };
