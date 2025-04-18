const Transaction = require('../models/Transaction');
const logger = require('../utils/logger');

// GET /transactions - Obtener transacciones con filtros y paginación
const getAllTransactions = async (req, res) => {
  try {
    const {
      merchantId,
      status,
      method,
      fromDate,
      toDate,
      page = 1,
      limit = 20
    } = req.query;

    const query = {};

    if (merchantId) query.merchantId = merchantId;
    if (status) query.status = status;
    if (method) query.method = method;
    if (fromDate || toDate) {
      query.createdAt = {};
      if (fromDate) query.createdAt.$gte = new Date(fromDate);
      if (toDate) query.createdAt.$lte = new Date(toDate);
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [total, transactions] = await Promise.all([
      Transaction.countDocuments(query),
      Transaction.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
    ]);

    res.status(200).json({
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      transactions
    });
  } catch (error) {
    logger.error('Error al obtener transacciones:', error);
    res.status(500).json({ message: 'Error al obtener transacciones' });
  }
};

module.exports = {
  getAllTransactions
};
