// src/controllers/pmsController.js
const { fetchReservationsPaginated } = require('../channels/pms/connectors/cloudbedsConnector');
const Transaction = require('../models/Transaction');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

const fetchAndStoreCloudbedsReservations = async (req, res) => {
  try {
    const { limit = 500 } = req.query; // límite de reservas a traer en esta ejecución
    const reservations = await fetchReservationsPaginated({ maxItems: Number(limit) });

    let created = 0;

    for (const resv of reservations) {
      const reservationId = resv.reservation_id;
      const existing = await Transaction.findOne({ reservationId });
      if (existing) {
        logger.info(`Reservation ${reservationId} already registered.`);
        continue;
      }

      const transaction = new Transaction({
        paymentId: uuidv4(),
        merchantId: 'cloudbeds-hotel',
        amount: parseFloat(resv.total || 0),
        currency: resv.currency_code || 'EUR',
        method: 'card',
        status: 'pending',
        reservationId,
        guestName: `${resv.guest_firstname || ''} ${resv.guest_lastname || ''}`.trim(),
        checkInDate: resv.start_date,
        checkOutDate: resv.end_date,
        roomType: resv.room_name,
        rateCode: resv.rate_name,
        channel: resv.channel_name,
        folioNumber: resv.folio_number
      });

      await transaction.save();
      created += 1;
      logger.info(`Created transaction for reservation ${reservationId}`);
    }

    return res.status(200).json({
      success: true,
      message: 'Cloudbeds reservations processed.',
      created
    });
  } catch (error) {
    logger.error('Error in fetchAndStoreCloudbedsReservations:', { error: error.message });
    return res.status(500).json({ success: false, message: 'Error fetching reservations from Cloudbeds.' });
  }
};

module.exports = { fetchAndStoreCloudbedsReservations };
