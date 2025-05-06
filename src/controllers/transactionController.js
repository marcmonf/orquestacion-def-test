// src/controllers/transactionController.js
const Joi = require('joi');
const { v4: uuidv4 } = require('uuid');
const Transaction = require('../models/Transaction');
const logger = require('../utils/logger');
const transactionSchema = require('../validators/transactionValidator');

// GET /transactions
const getAllTransactions = async (req, res) => {
  try {
    const { merchantId, status, method, fromDate, toDate, page = 1, limit = 20 } = req.query;
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
      Transaction.find(query).sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit))
    ]);

    logger.info('Transacciones obtenidas', { total, query });
    res.status(200).json({ page: parseInt(page), limit: parseInt(limit), total, transactions });
  } catch (error) {
    logger.error('Error al obtener transacciones', { error: error.message });
    res.status(500).json({
      success: false,
      message: res.getMessage('transaction.fetch.error')
    });
  }
};

// POST /transactions
const createTransaction = async (req, res) => {
  const { error, value } = transactionSchema.validate(req.body);
  if (error) {
    const messageKey = error.details[0].message;
    const translated = res.getMessage?.(messageKey) || messageKey || 'transaction.validation';
    logger.warn('Validación fallida en creación', { details: messageKey });
    return res.status(400).json({
      success: false,
      message: translated
    });
  }

  try {
    let recurrenceId = value.recurrenceId || null;

    // CIT recurrente: generamos recurrenceId
    if (value.transactionType === 'CIT' && value.isRecurring) {
      recurrenceId = uuidv4();
    }

    // MIT: validar que exista CIT previa con ese recurrenceId y token
    if (value.transactionType === 'MIT') {
      const previous = await Transaction.findOne({
        recurrenceId: value.recurrenceId,
        token: value.token,
        transactionType: 'CIT'
      });

      if (!previous) {
        logger.warn('MIT sin CIT previa vinculada', {
          recurrenceId: value.recurrenceId,
          token: value.token
        });

        return res.status(400).json({
          success: false,
          message: res.getMessage('transaction.invalid.mit.noMatch')
        });
      }
    }

    const newTransaction = new Transaction({
      ...value,
      paymentId: value.paymentId || uuidv4(),
      recurrenceId
    });

    await newTransaction.save();
    logger.info('Transacción creada', {
      paymentId: newTransaction.paymentId,
      method: newTransaction.method,
      token: newTransaction.token,
      transactionType: newTransaction.transactionType,
      isRecurring: newTransaction.isRecurring,
      recurrenceId: newTransaction.recurrenceId
    });

    res.status(201).json({
      success: true,
      message: res.getMessage('transaction.created'),
      transaction: newTransaction
    });
  } catch (err) {
    logger.error('Error al crear transacción', { error: err.message });
    res.status(500).json({
      success: false,
      message: res.getMessage('transaction.create.error')
    });
  }
};

// GET /transactions/:paymentId
const getTransactionById = async (req, res) => {
  try {
    const { paymentId } = req.params;
    const transaction = await Transaction.findOne({ paymentId });
    if (!transaction) {
      logger.warn('Transacción no encontrada', { paymentId });
      return res.status(404).json({
        success: false,
        message: res.getMessage('transaction.not.found')
      });
    }

    logger.info('Transacción obtenida por ID', { paymentId });
    res.status(200).json({ success: true, transaction });
  } catch (err) {
    logger.error('Error al obtener transacción', { error: err.message });
    res.status(500).json({
      success: false,
      message: res.getMessage('transaction.fetch.error')
    });
  }
};

// PUT /transactions/:paymentId
const updateTransaction = async (req, res) => {
  try {
    const { paymentId } = req.params;
    const updates = req.body;
    const transaction = await Transaction.findOneAndUpdate({ paymentId }, { $set: updates }, { new: true });

    if (!transaction) {
      logger.warn('Transacción no encontrada para actualizar', { paymentId });
      return res.status(404).json({
        success: false,
        message: res.getMessage('transaction.not.found')
      });
    }

    logger.info('Transacción actualizada', { paymentId, updates });
    res.status(200).json({
      success: true,
      message: res.getMessage('transaction.updated'),
      transaction
    });
  } catch (err) {
    logger.error('Error al actualizar transacción', { error: err.message });
    res.status(500).json({
      success: false,
      message: res.getMessage('transaction.update.error')
    });
  }
};

// DELETE /transactions/:paymentId
const deleteTransaction = async (req, res) => {
  try {
    const { paymentId } = req.params;
    const deleted = await Transaction.findOneAndDelete({ paymentId });

    if (!deleted) {
      logger.warn('Transacción no encontrada para eliminar', { paymentId });
      return res.status(404).json({
        success: false,
        message: res.getMessage('transaction.not.found')
      });
    }

    logger.info('Transacción eliminada', { paymentId });
    res.status(200).json({
      success: true,
      message: res.getMessage('transaction.deleted')
    });
  } catch (err) {
    logger.error('Error al eliminar transacción', { error: err.message });
    res.status(500).json({
      success: false,
      message: res.getMessage('transaction.delete.error')
    });
  }
};

// Analytics...

// (las funciones de analítica no cambian y se mantienen igual)

module.exports = {
  getAllTransactions,
  createTransaction,
  getTransactionById,
  updateTransaction,
  deleteTransaction,
  getTransactionVolume,
  getApprovalRate,
  getAverageMSC,
  getTransactionSummary
};
