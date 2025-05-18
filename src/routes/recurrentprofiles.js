// src/routes/recurrentprofiles.js
const express = require('express');
const router = express.Router();
const RecurrentProfile = require('../models/RecurrentProfile');
const logger = require('../utils/logger');

// GET /recurrent-profiles
router.get('/', async (req, res) => {
  try {
    const { merchantId, token, recurrenceId } = req.query;
    const query = {};

    if (merchantId) query.merchantId = merchantId;
    if (token) query.token = token;
    if (recurrenceId) query.recurrenceId = recurrenceId;

    const profiles = await RecurrentProfile.find(query).sort({ createdAt: -1 });

    logger.info('>>> Entrando en GET /recurrent-profiles', { total: profiles.length, query });

    res.status(200).json({ success: true, profiles });
  } catch (error) {
    logger.error('Error al consultar perfiles recurrentes', { error: error.message });
    res.status(500).json({
      success: false,
      message: res.getMessage?.('recurrentProfiles.fetch.error') || 'Error fetching recurrent profiles.'
    });
  }
});

module.exports = router;
