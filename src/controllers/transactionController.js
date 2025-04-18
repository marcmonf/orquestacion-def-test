const Joi = require('joi');
const { v4: uuidv4 } = require('uuid');
const Transaction = require('../models/Transaction');
const logger = require('../utils/logger');
const transactionSchema = require('../validators/transactionValidator');

// GET /transactions - Obtener transacciones con filtros y paginación
const getAllTransactions = async (req, res) => {
  try {
    const {
      merchantId, status, method,
      fromDate, toDate,
      page = 1, limit = 20
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

    res.status(200).json({ page: parseInt(page), limit: parseInt(limit), total, transactions });
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

    const newTransaction = new Transaction({
      ...value,
      paymentId: value.paymentId || uuidv4()
    });

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

// PUT /transactions/:paymentId - Actualizar una transacción
const updateTransaction = async (req, res) => {
  try {
    const { paymentId } = req.params;
    const updates = req.body;

    const transaction = await Transaction.findOneAndUpdate(
      { paymentId },
      { $set: updates },
      { new: true }
    );

    if (!transaction) {
      return res.status(404).json({ error: 'Transacción no encontrada' });
    }

    logger.info(`Transacción actualizada: ${paymentId}`);
    res.status(200).json({ message: 'Transacción actualizada', transaction });
  } catch (err) {
    logger.error('Error al actualizar transacción:', err);
    res.status(500).json({ error: 'Error al actualizar transacción' });
  }
};

// DELETE /transactions/:paymentId - Eliminar una transacción
const deleteTransaction = async (req, res) => {
  try {
    const { paymentId } = req.params;
    const deleted = await Transaction.findOneAndDelete({ paymentId });

    if (!deleted) {
      return res.status(404).json({ error: 'Transacción no encontrada' });
    }

    logger.info(`Transacción eliminada: ${paymentId}`);
    res.status(200).json({ message: 'Transacción eliminada' });
  } catch (err) {
    logger.error('Error al eliminar transacción:', err);
    res.status(500).json({ error: 'Error al eliminar transacción' });
  }
};

// GET /transactions/metrics/summary - Métricas globales
const getSummaryMetrics = async (req, res) => {
  try {
    const total = await Transaction.countDocuments();
    const approved = await Transaction.countDocuments({ status: 'approved' });
    const declined = await Transaction.countDocuments({ status: 'declined' });

    res.status(200).json({
      totalTransactions: total,
      approvedTransactions: approved,
      declinedTransactions: declined,
      approvalRate: total ? ((approved / total) * 100).toFixed(2) + '%' : '0%'
    });
  } catch (err) {
    logger.error('Error al obtener métricas:', err);
    res.status(500).json({ error: 'Error al obtener métricas' });
  }
};

// GET /transactions/metrics/volume - Volumen total de transacciones
const getVolumeMetrics = async (req, res) => {
  try {
    const result = await Transaction.aggregate([
      { $match: { status: 'approved' } },
      { $group: { _id: null, totalVolume: { $sum: '$amount' } } }
    ]);

    const volume = result[0]?.totalVolume || 0;
    res.status(200).json({ totalVolume: volume });
  } catch (err) {
    logger.error('Error al obtener volumen:', err);
    res.status(500).json({ error: 'Error al obtener volumen de transacciones' });
  }
};

module.exports = {
  getAllTransactions,
  createTransaction,
  getTransactionById,
  updateTransaction,
  deleteTransaction,
  getSummaryMetrics,
  getVolumeMetrics
};
