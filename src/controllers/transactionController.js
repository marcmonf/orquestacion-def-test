// src/controllers/transactionController.js
const Joi = require('joi');
const { v4: uuidv4 } = require('uuid');
const Transaction = require('../models/Transaction');
const logger = require('../utils/logger');
const auditLogger = require('../logs/auditLogger');
const transactionSchema = require('../validators/transactionValidator');
const { createTokenForCard } = require('../services/tokenService');
const RecurrentProfile = require('../models/RecurrentProfile');
const mbwayConnector = require('../channels/apms/hub/connectors/mbwayConnector');

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

    auditLogger.info({
      action: 'TRANSACTION_VALIDATION_FAILED',
      user: req.merchantId || 'unknown',
      details: { error: messageKey, input: req.body },
      metadata: { ip: req.ip, method: req.method, url: req.originalUrl }
    });

    return res.status(400).json({
      success: false,
      message: translated
    });
  }

  try {
    const existingTx = await Transaction.findOne({ paymentId: value.paymentId });
    if (existingTx) {
      logger.info('Transacción repetida detectada (idempotencia)', { paymentId: value.paymentId });
      return res.status(200).json({
        success: true,
        message: res.getMessage('transaction.created'),
        transaction: existingTx,
        recurrenceId: existingTx.recurrenceId,
        token: existingTx.token || null
      });
    }

    let recurrenceId = value.recurrenceId || null;
    let token = value.token || null;

    if (value.transactionType === 'CIT' && value.isRecurring) {
      recurrenceId = uuidv4();

      token = await createTokenForCard({
        cardNumber: value.cardNumber,
        cardholderName: value.cardholderName,
        expiryMonth: value.expiryMonth,
        expiryYear: value.expiryYear,
        cvv: value.cvv
      });

      await new RecurrentProfile({
        recurrenceId,
        token,
        merchantId: value.merchantId,
        cardholderName: value.cardholderName,
        expiryMonth: value.expiryMonth,
        expiryYear: value.expiryYear
      }).save();
    }

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

        auditLogger.info({
          action: 'MIT_WITHOUT_CIT',
          user: req.merchantId || 'unknown',
          details: { recurrenceId: value.recurrenceId, token: value.token },
          metadata: { ip: req.ip, method: req.method, url: req.originalUrl }
        });

        return res.status(400).json({
          success: false,
          message: res.getMessage('transaction.invalid.mit.noMatch')
        });
      }
    }

    const sanitizedValue = { ...value };
    delete sanitizedValue.cvv;
    delete sanitizedValue.cardNumber;

    if (value.method === 'mbway') {
      const mbwayResult = await mbwayConnector.process(value);
      sanitizedValue.status = mbwayResult.status;
      sanitizedValue.processor = mbwayResult.processor;
      sanitizedValue.transactionId = mbwayResult.transactionId;
      sanitizedValue.authCode = mbwayResult.authCode;
      sanitizedValue.timestamp = mbwayResult.timestamp;
    }

    const newTransaction = new Transaction({
      ...sanitizedValue,
      paymentId: value.paymentId || uuidv4(),
      recurrenceId,
      token
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

    auditLogger.info({
      action: 'TRANSACTION_CREATED',
      user: req.merchantId || 'unknown',
      details: {
        paymentId: newTransaction.paymentId,
        method: newTransaction.method,
        transactionType: newTransaction.transactionType,
        isRecurring: newTransaction.isRecurring,
        recurrenceId: newTransaction.recurrenceId
      },
      metadata: { ip: req.ip, method: req.method, url: req.originalUrl }
    });

    res.status(201).json({
      success: true,
      message: res.getMessage('transaction.created'),
      transaction: newTransaction,
      recurrenceId,
      token
    });
  } catch (err) {
    logger.error('Error al crear transacción', { error: err.message });

    auditLogger.info({
      action: 'TRANSACTION_CREATE_ERROR',
      user: req.merchantId || 'unknown',
      details: { error: err.message },
      metadata: { ip: req.ip, method: req.method, url: req.originalUrl }
    });

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

// ANALYTICS

const getTransactionVolume = async (req, res) => {
  try {
    const result = await Transaction.aggregate([
      { $match: { status: 'approved' } },
      { $group: { _id: null, totalVolume: { $sum: '$amount' } } }
    ]);
    const totalVolume = result[0]?.totalVolume || 0;
    logger.info('Volumen total obtenido', { totalVolume });
    res.status(200).json({ totalVolume });
  } catch (err) {
    logger.error('Error al obtener volumen', { error: err.message });
    res.status(500).json({
      success: false,
      message: res.getMessage('transaction.analytics.volume.error')
    });
  }
};

const getApprovalRate = async (req, res) => {
  try {
    const total = await Transaction.countDocuments();
    const approved = await Transaction.countDocuments({ status: 'approved' });
    const rate = total ? ((approved / total) * 100).toFixed(2) : '0';
    logger.info('Tasa de aprobación obtenida', { total, approved, rate });
    res.status(200).json({ approvalRate: `${rate}%` });
  } catch (err) {
    logger.error('Error al obtener tasa aprobación', { error: err.message });
    res.status(500).json({
      success: false,
      message: res.getMessage('transaction.analytics.approvalRate.error')
    });
  }
};

const getAverageMSC = async (req, res) => {
  try {
    const result = await Transaction.aggregate([
      { $match: { status: 'approved' } },
      { $group: { _id: null, average: { $avg: '$amount' } } }
    ]);
    const averageMSC = result[0]?.average || 0;
    logger.info('MSC promedio obtenido', { averageMSC });
    res.status(200).json({ averageMSC });
  } catch (err) {
    logger.error('Error al obtener MSC promedio', { error: err.message });
    res.status(500).json({
      success: false,
      message: res.getMessage('transaction.analytics.averageMsc.error')
    });
  }
};

const getTransactionSummary = async (req, res) => {
  try {
    const total = await Transaction.countDocuments();
    const approved = await Transaction.countDocuments({ status: 'approved' });
    const declined = await Transaction.countDocuments({ status: 'declined' });
    const volumeResult = await Transaction.aggregate([
      { $match: { status: 'approved' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);
    const volume = volumeResult[0]?.total || 0;

    logger.info('Resumen de métricas obtenido', { total, approved, declined, volume });
    res.status(200).json({
      totalTransactions: total,
      approvedTransactions: approved,
      declinedTransactions: declined,
      approvalRate: total ? ((approved / total) * 100).toFixed(2) + '%' : '0%',
      totalVolume: volume
    });
  } catch (err) {
    logger.error('Error al obtener resumen de métricas', { error: err.message });
    res.status(500).json({
      success: false,
      message: res.getMessage('transaction.analytics.summary.error')
    });
  }
};

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
