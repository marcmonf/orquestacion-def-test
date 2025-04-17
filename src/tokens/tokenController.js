const Token = require('../models/Token');
const crypto = require('crypto');

// Función auxiliar para generar token aleatorio
const generateToken = () => {
  return crypto.randomBytes(16).toString('hex');
};

const tokenizeCard = async (req, res) => {
  const { pan, expiry } = req.body;

  if (!pan || !expiry) {
    return res.status(400).json({ error: 'Faltan datos de tarjeta' });
  }

  try {
    const token = generateToken();
    const newToken = new Token({ token, pan, expiry });
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
      expiry: record.expiry
    });
  } catch (err) {
    console.error('Error al recuperar tarjeta:', err);
    return res.status(500).json({ error: 'Error interno' });
  }
};

module.exports = { tokenizeCard, getCardData };
