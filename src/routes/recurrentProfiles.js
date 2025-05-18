// src/routes/recurrentProfiles.js
const express = require('express');
const router = express.Router();
const RecurrentProfile = require('../models/RecurrentProfile');
const logger = require('../utils/logger');
const checkRole = require('../middleware/checkRole');

// GET /recurrent-profiles
router.get('/', checkRole(['admin']), async (req, res) => {
  try {
    const { merchantId, token, recurrenceId } = req.query;
    const query = {};

    if (merchantId) query.merchantId = merchantId;
    if (token) query.token = token;
    if (recurrenceId) query.recurrenceId = recurrenceId;

    const profiles = await RecurrentProfile.find(query).sort({ createdAt: -1 });

    logger.info('Perfiles recurrentes consultados', { total: profiles.length, query });

    res.status(200).json({ success: true, profiles });
  } catch (error) {
    logger.error('Error al consultar perfiles recurrentes', { error: error.message });
    res.status(500).json({
      success: false,
      message: res.getMessage('recurrentProfiles.fetch.error') || 'Error fetching recurrent profiles.'
    });
  }
});

module.exports = router;
