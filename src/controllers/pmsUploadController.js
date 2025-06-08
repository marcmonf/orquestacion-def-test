// src/controllers/pmsUploadController.js
const { parseCsvReservations } = require('../utils/csvParser');
const Transaction = require('../models/Transaction');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

const uploadReservationsFromCsv = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No CSV file uploaded.'
      });
    }

    const reservations = await parseCsvReservations(req.file.buffer);
    let createdCount = 0;

    for (const resv of reservations) {
      const exists = await Transaction.findOne({ reservationId: resv.reservationId });

      if (exists) {
        logger.info(`Reservation ${resv.reservationId} already registered.`);
        continue;
      }

      const transaction = new Transaction({
        paymentId: uuidv4(),
        merchantId: 'manual-hotel-import',
        amount: resv.amount,
        currency: resv.currency,
        method: 'card',
        status: 'pending',
        reservationId: resv.reservationId,
        guestName: resv.guestName,
        checkInDate: resv.checkInDate,
        checkOutDate: resv.checkOutDate,
        roomType: resv.roomType,
        rateCode: resv.rateCode,
        channel: resv.channel,
        folioNumber: resv.folioNumber
      });

      await transaction.save();
      createdCount++;
    }

    return res.status(200).json({
      success: true,
      message: 'Reservations processed successfully.',
      created: createdCount
    });
  } catch (error) {
    logger.error('CSV upload error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Error processing reservations CSV file.'
    });
  }
};

module.exports = { uploadReservationsFromCsv };
