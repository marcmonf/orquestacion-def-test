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
        folioNumber: resv.folioNumber,
        cardholderName: 'PENDING_GUEST',
        expiryMonth: '12',
        expiryYear: '2099'
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

const getReservations = async (req, res) => {
  try {
    const { merchantId, status, from, to } = req.query;

    const filter = {};
    if (merchantId) filter.merchantId = merchantId;
    if (status) filter.status = status;
    if (from || to) {
      filter.checkInDate = {};
      if (from) filter.checkInDate.$gte = new Date(from);
      if (to) filter.checkInDate.$lte = new Date(to);
    }

    const reservations = await Transaction.find(filter).sort({ checkInDate: 1 });

    return res.status(200).json({
      success: true,
      message: res.getMessage('pms.reservationListSuccess'),
      data: reservations
    });
  } catch (error) {
    logger.error('Error fetching reservations:', error.message);
    return res.status(500).json({
      success: false,
      message: res.getMessage('pms.reservationListError')
    });
  }
};

module.exports = {
  uploadReservationsFromCsv,
  getReservations
};
