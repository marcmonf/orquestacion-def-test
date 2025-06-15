// src/controllers/pmsQueryController.js
const Transaction = require('../models/Transaction');
const logger = require('../utils/logger');

const getUploadedReservations = async (req, res) => {
  try {
    const { merchantId = 'manual-hotel-import', status, checkInFrom, checkInTo } = req.query;

    // Construir filtro dinámico
    const filter = { merchantId };

    if (status) {
      filter.status = status;
    }

    if (checkInFrom || checkInTo) {
      filter.checkInDate = {};
      if (checkInFrom) {
        filter.checkInDate.$gte = new Date(checkInFrom);
      }
      if (checkInTo) {
        filter.checkInDate.$lte = new Date(checkInTo);
      }
    }

    const reservations = await Transaction.find(filter).sort({ checkInDate: 1 });

    return res.status(200).json({
      success: true,
      message: 'Reservations retrieved successfully.',
      total: reservations.length,
      reservations
    });
  } catch (error) {
    logger.error('Error retrieving reservations:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Error retrieving reservations.'
    });
  }
};

module.exports = { getUploadedReservations };
