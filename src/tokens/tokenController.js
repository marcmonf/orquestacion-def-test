// ✅ tokenController.js
const Token = require('../models/Token');
const crypto = require('crypto');
const tokenSchema = require('../validators/tokenValidator');
const { encryptPan, decryptPan } = require('../utils/cryptoUtils');
const { isValidPanAndCvv } = require('../utils/cardUtils'); // ✅ nuevo

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

  // ✅ Validación adicional por esquema
  if (!isValidPanAndCvv(cardNumber, cvv)) {
    return res.status(400).json({
      success: false,
      message: res.getMessage('token.invalid.cardNumberOrCvv')
    });
  }

  try {
    const token = generateToken();
    const encryptedPan = encryptPan(cardNumber);

    const newToken = new Token({
      token,
      pan: encryptedPan,
      expiryMonth,
      expiryYear,
      cardholderName
    });

    await newToken.save();

    return res.status(201).json({
      success: true,
      token,
      message: res.getMessage('token.created')
    });
  } catch (err) {
    console.error('Error al tokenizar tarjeta:', err);
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
    console.error('Error al recuperar tarjeta:', err);
    return res.status(500).json({
      success: false,
      message: res.getMessage('token.error')
    });
  }
};

module.exports = { tokenizeCard, getCardData };
