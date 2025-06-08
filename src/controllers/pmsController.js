// src/controllers/pmsController.js
const { fetchReservations } = require('../channels/pms/connectors/cloudbedsConnector');
const Transaction = require('../models/Transaction');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

const fetchAndStoreCloudbedsReservations = async (req, res) => {
  try {
    const reservations = await fetchReservations();

    const createdTransactions = [];

    for (const resv of reservations) {
      const reservationId = resv.reservation_id;

      // Verificamos si ya existe una transacción para esta reserva
      const existing = await Transaction.findOne({ reservationId });
      if (existing) {
        logger.info(`Reservation ${reservationId} already registered.`);
        continue;
      }

      const transaction = new Transaction({
        paymentId: uuidv4(),
        merchantId: 'cloudbeds-hotel', // Personalizable
        amount: parseFloat(resv.total || 0),
        currency: resv.currency_code || 'EUR',
        method: 'card',
        status: 'pending',
        reservationId: reservationId,
        guestName: `${resv.guest_firstname} ${resv.guest_lastname}`,
        checkInDate: resv.start_date,
        checkOutDate: resv.end_date,
        roomType: resv.room_name,
        rateCode: resv.rate_name,
        channel: resv.channel_name,
        folioNumber: resv.folio_number
      });

      await transaction.save();
      createdTransactions.push(transaction);
      logger.info(`Created transaction for reservation ${reservationId}`);
    }

    return res.status(200).json({
      success: true,
      message: 'Cloudbeds reservations processed.',
      created: createdTransactions.length
    });
  } catch (error) {
    logger.error('Error in fetchAndStoreCloudbedsReservations:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Error fetching reservations from Cloudbeds.'
    });
  }
};

module.exports = {
  fetchAndStoreCloudbedsReservations
};
