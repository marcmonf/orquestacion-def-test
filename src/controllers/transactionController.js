const Joi = require('joi');
const Transaction = require('../models/Transaction');
const logger = require('../utils/logger');
const transactionSchema = require('../validators/transactionValidator');

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

// POST /transactions - Crear nueva transacción
const createTransaction = async (req, res) => {
  try {
    const { error, value } = transactionSchema.validate(req.body);
    if (error) {
      logger.warn('Validación fallida en creación de transacción:', error.details[0].message);
      return res.status(400).json({ error: error.details[0].message });
    }

    const newTransaction = new Transaction(value);
    await newTransaction.save();

    logger.info(`Transacción creada: ${newTransaction.paymentId}`);
    res.status(201).json({ message: 'Transacción creada', transaction: newTransaction });
  } catch (err) {
    logger.error('Error al crear transacción:', err);
    res.status(500).json({ message: 'Error al crear transacción' });
  }
};

// GET /transactions/:paymentId - Obtener una transacción por ID
const getTransactionById = async (req, res) => {
  try {
    const { paymentId } = req.params;
    const transaction = await Transaction.findOne({ paymentId });

    if (!transaction) {
      return res.status(404).json({ error: 'Transacción no encontrada' });
    }

    res.status(200).json(transaction);
  } catch (err) {
    logger.error('Error al obtener transacción por ID:', err);
    res.status(500).json({ error: 'Error al obtener transacción' });
  }
};

module.exports = {
  getAllTransactions,
  createTransaction,
  getTransactionById
};
