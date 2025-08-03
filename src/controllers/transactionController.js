// src/controllers/transactionController.js
const Joi = require('joi');
const { v4: uuidv4 } = require('uuid');
const Transaction = require('../models/Transaction');
const logger = require('../utils/logger');
const auditLogger = require('../logs/auditLogger');
const transactionSchema = require('../validators/transactionValidator');
const { createTokenForCard } = require('../services/tokenService');
const RecurrentProfile = require('../models/RecurrentProfile');

// Motores y conectores
const { selectConnector } = require('../orchestrator/orchestrationEngine');
const mbwayConnector = require('../channels/apms/hub/connectors/mbwayConnector');
const { initiatePayment: initiateBizumPayment } = require('../channels/apms/hub/connectors/bizumConnector');
const { initiatePayment: initiatePixPayment } = require('../channels/apms/hub/connectors/pixConnector');

// Mock de adquirentes para demo
const visaAcquirer = require('../channels/acquirers/visaAcquirer');
const mcAcquirer = require('../channels/acquirers/mcAcquirer');
const amexAcquirer = require('../channels/acquirers/amexAcquirer');
const defaultCardAcquirer = require('../channels/acquirers/defaultCardAcquirer');

// ... Resto del archivo sin cambios hasta llegar a createTransaction ...

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
    const generatedPaymentId = uuidv4();
    let recurrenceId = value.recurrenceId || null;
    let token = value.token || null;
    let qrCodeImage = null;

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

    if (value.returnUrl) {
      sanitizedValue.returnUrl = value.returnUrl;
    }

    // 🧠 Motor de orquestación
    const selectedConnector = await selectConnector(value);
    logger.info(`🧠 Orchestrator selected connector: ${selectedConnector}`);

    auditLogger.info({
      action: 'ORCHESTRATION_DECISION',
      user: req.merchantId || 'unknown',
      details: {
        selectedConnector,
        method: value.method,
        merchantId: value.merchantId,
        cardScheme: value.cardScheme
      },
      metadata: { ip: req.ip, method: req.method, url: req.originalUrl }
    });

    // Ejecutar conector elegido
    let response;
    switch (selectedConnector) {
      case 'mbwayConnector':
        response = await mbwayConnector.process(value);
        break;
      case 'bizumConnector':
        response = await initiateBizumPayment(value);
        break;
      case 'pixConnector':
        response = await initiatePixPayment(value);
        sanitizedValue.qrCodePayload = response.qrCodePayload;
        sanitizedValue.paymentUrl = response.paymentUrl;
        qrCodeImage = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(response.qrCodePayload)}`;
        break;
      case 'visaAcquirer':
        response = await visaAcquirer.initiatePayment(value);
        break;
      case 'mcAcquirer':
        response = await mcAcquirer.initiatePayment(value);
        break;
      case 'amexAcquirer':
        response = await amexAcquirer.initiatePayment(value);
        break;
      case 'defaultCardAcquirer':
        response = await defaultCardAcquirer.initiatePayment(value);
        break;
      default:
        throw new Error(`Unsupported connector: ${selectedConnector}`);
    }

    sanitizedValue.status = response.status;
    sanitizedValue.processor = response.processor;
    sanitizedValue.transactionId = response.transactionId;
    if (response.authCode) sanitizedValue.authCode = response.authCode;
    if (response.timestamp) sanitizedValue.timestamp = response.timestamp;

    const newTransaction = new Transaction({
      ...sanitizedValue,
      paymentId: generatedPaymentId,
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
      token,
      qrCodeImage
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

// 🔁 El resto del archivo permanece igual (GET, PUT, DELETE, analytics...)

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
