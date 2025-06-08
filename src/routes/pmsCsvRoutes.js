// src/routes/pmsCsvRoutes.js
const express = require('express');
const router = express.Router();
const Transaction = require('../models/Transaction');
const logger = require('../utils/logger');
const apiKeyAuth = require('../middleware/auth');
const checkRole = require('../middleware/checkRole');
const rateLimiter = require('../middleware/rateLimiter');

router.get('/csv-reservations', apiKeyAuth, checkRole(['admin']), rateLimiter, async (req, res) => {
  try {
    const { status, from, to } = req.query;

    const filter = {
      merchantId: 'manual-hotel-import'
    };

    if (status) {
      filter.status = status;
    }

    if (from || to) {
      filter.checkInDate = {};
      if (from) filter.checkInDate.$gte = new Date(from);
      if (to) filter.checkInDate.$lte = new Date(to);
    }

    const reservations = await Transaction.find(filter).sort({ checkInDate: 1 });

    return res.status(200).json({
      success: true,
      message: 'Filtered reservations retrieved successfully.',
      reservations
    });
  } catch (error) {
    logger.error('Error fetching CSV reservations:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Internal server error while retrieving CSV reservations.'
    });
  }
});

module.exports = router;
