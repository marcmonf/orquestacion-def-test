const Transaction = require('../models/Transaction');
const logger = require('../utils/logger');

// Obtener todas las transacciones ordenadas por fecha descendente
const getAllTransactions = async () => {
  try {
    const transactions = await Transaction.find().sort({ createdAt: -1 });
    return transactions;
  } catch (error) {
    logger.error('Error al obtener transacciones:', error);
    throw new Error('Error al obtener transacciones');
  }
};

module.exports = {
  getAllTransactions
};
