// src/controllers/cardPaymentController.js
const axios = require('axios');
const Transaction = require('../models/Transaction');
const { lookupBin } = require('../services/binService');
const { decideConnector } = require('../rules/ruleEngine');
const logger = require('../utils/logger');

// POST /transactions/card-payment
async function cardPayment(req, res) {
  try {
    const {
      paymentId,
      cardholderName,
      cardNumber,
      expiryMonth,
      expiryYear,
      cvv
    } = req.body;

    // 1. Buscar la transacción creada con /initialize
    const tx = await Transaction.findOne({ paymentId });
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });

    // 2. Enriquecer con datos BIN
    const first8 = cardNumber.slice(0, 8);
    const binInfo = await lookupBin(first8);        // cache-first, API fallback

    Object.assign(tx, {
      bin: first8,
      cardholderName,
      expiryMonth,
      expiryYear,
      ...binInfo           // cardBrand, issuerCountry, etc.
    });

    // 3. Rule Engine: elegir conector
    const connector = await decideConnector(tx);
    tx.processor = connector;

    // 4. Guardar la transacción enriquecida
    await tx.save();

    // 5. (Mock) devolver conector elegido
    return res.status(200).json({
      success: true,
      connector,
      binInfo
    });
  } catch (err) {
    logger.error('cardPayment error', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { cardPayment };
