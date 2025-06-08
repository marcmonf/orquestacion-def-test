// src/utils/csvParser.js
const csv = require('csv-parser');
const { Readable } = require('stream');

const parseCsvReservations = async (buffer) => {
  return new Promise((resolve, reject) => {
    const reservations = [];

    const stream = Readable.from(buffer);

    stream
      .pipe(csv())
      .on('data', (row) => {
        try {
          // Validar y limpiar los campos esenciales
          const cleaned = {
            reservationId: row.reservationId?.trim(),
            guestName: row.guestName?.trim(),
            amount: parseFloat(row.amount),
            currency: row.currency?.trim() || 'EUR',
            checkInDate: new Date(row.checkInDate),
            checkOutDate: new Date(row.checkOutDate),
            roomType: row.roomType?.trim(),
            rateCode: row.rateCode?.trim(),
            channel: row.channel?.trim(),
            folioNumber: row.folioNumber?.trim()
          };

          // Validación básica: campos obligatorios
          if (
            !cleaned.reservationId ||
            !cleaned.guestName ||
            isNaN(cleaned.amount) ||
            !cleaned.checkInDate ||
            !cleaned.checkOutDate
          ) {
            return; // Saltar fila inválida
          }

          reservations.push(cleaned);
        } catch (err) {
          // Silenciar error por fila malformada
        }
      })
      .on('end', () => {
        resolve(reservations);
      })
      .on('error', (err) => {
        reject(err);
      });
  });
};

module.exports = { parseCsvReservations };
