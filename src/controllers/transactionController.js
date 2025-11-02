// src/controllers/transactionController.js
'use strict';

const Joi                       = require('joi');
const { v4: uuidv4 }            = require('uuid');
const Transaction               = require('../models/Transaction');
const logger                    = require('../utils/logger');
const auditLogger               = require('../logs/auditLogger');
const transactionSchema         = require('../validators/transactionValidator');
const { createTokenForCard }    = require('../services/tokenService');
const RecurrentProfile          = require('../models/RecurrentProfile');

const { selectConnector }       = require('../orchestrator/orchestrationEngine');
const { executeCardPayment }    = require('../orchestrator/fallbackEngine');

const mbwayConnector            = require('../channels/apms/hub/connectors/mbwayConnector');
const { initiatePayment: initiateBizumPayment } = require('../channels/apms/hub/connectors/bizumConnector');
const { initiatePayment: initiatePixPayment }   = require('../channels/apms/hub/connectors/pixConnector');

const visaAcquirer              = require('../channels/acquirers/visaAcquirer');
const mcAcquirer                = require('../channels/acquirers/mcAcquirer');
const amexAcquirer              = require('../channels/acquirers/amexAcquirer');
const defaultCardAcquirer       = require('../channels/acquirers/defaultCardAcquirer');

const { parseBin }              = require('../utils/cardInfoParser');
const webhookDispatcher         = require('../services/webhookDispatcher');

/* ------------ FLAGS / TIMEOUTS ------------- */
const TX_TIMEOUT_MS         = Math.max(1000, parseInt(process.env.TX_TIMEOUT_MS || '8000', 10));
const FEATURE_ASYNC_PERSIST = process.env.FEATURE_ASYNC_PERSIST === '1';
const PERSIST_TIMEOUT_MS    = Math.max(500, Math.min(5000, parseInt(process.env.PERSIST_TIMEOUT_MS || '3000', 10)));
const DB_QUERY_TIMEOUT_MS   = Math.max(300, Math.min(5000, parseInt(process.env.DB_QUERY_TIMEOUT_MS || '1200', 10)));
const BIN_OFFLINE           = process.env.BIN_OFFLINE === '1';
const FAST_TX               = process.env.FAST_TX === '1'; // fast-path opcional

/* utils */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout:${label}`)), ms);
    promise.then(v => { clearTimeout(t); resolve(v); })
           .catch(e => { clearTimeout(t); reject(e); });
  });
}
function nowIso() { return new Date().toISOString(); }

/* --------------------------------------------------------------------------- */
const getAllTransactions = async (req, res) => {
  try {
    const { merchantId, status, method, fromDate, toDate, page = 1, limit = 20 } = req.query;
    const query = {};
    if (merchantId) query.merchantId = merchantId;
    if (status)     query.status     = status;
    if (method)     query.method     = method;
    if (fromDate || toDate) {
      query.createdAt = {};
      if (fromDate) query.createdAt.$gte = new Date(fromDate);
      if (toDate)   query.createdAt.$lte = new Date(toDate);
    }
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [total, transactions] = await Promise.all([
      withTimeout(Transaction.countDocuments(query), DB_QUERY_TIMEOUT_MS, 'mongo-count'),
      withTimeout(
        Transaction.find(query).sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)),
        DB_QUERY_TIMEOUT_MS,
        'mongo-find'
      )
    ]);
    logger.info('Transacciones obtenidas', { total, query });
    res.status(200).json({ page: parseInt(page), limit: parseInt(limit), total, transactions });
  } catch (error) {
    logger.error('Error al obtener transacciones', { error: error.message });
    res.status(500).json({ success: false, message: res.getMessage('transaction.fetch.error') });
  }
};

/* --------------------------------------------------------------------------- */
const createTransaction = async (req, res) => {
  // Validación
  const { error, value } = transactionSchema.validate(req.body);
  if (error) {
    const messageKey = error.details?.[0]?.message || error.details?.[0]?.type || 'transaction.validation';
    const translated = res.getMessage?.(messageKey) || messageKey;
    logger.warn('Validación fallida en creación', { details: messageKey });
    auditLogger.info({
      action: 'TRANSACTION_VALIDATION_FAILED',
      user: req.merchantId || 'unknown',
      details: { error: messageKey },
      metadata: { ip: req.ip, method: req.method, url: req.originalUrl }
    });
    return res.status(400).json({ success: false, message: translated });
  }

  const hardAbortTimer = setTimeout(() => {
    logger.error('TX hard timeout alcanzado', { merchantId: value.merchantId, amount: value.amount });
    try { res.status(504).json({ success: false, error: 'timeout', message: `No respuesta en ${TX_TIMEOUT_MS}ms` }); } catch {}
  }, TX_TIMEOUT_MS);

  try {
    const generatedPaymentId = uuidv4();

    // Fast-path opcional
    if (FAST_TX) {
      const sanitized = { ...value };
      delete sanitized.cvv; delete sanitized.cardNumber;
      let status = 'approved';
      let capturedAt = undefined;
      let capturedAmount = undefined;

      if (sanitized.captureNow === true && sanitized.method === 'card') {
        status = 'captured';
        capturedAt = nowIso();
        capturedAmount = sanitized.amount;
      }

      const response = {
        status,
        processor: 'fast-sim',
        transactionId: `tx_${Date.now()}`,
        authCode: 'FASTOK',
        timestamp: nowIso()
      };

      const doc = new Transaction({
        ...sanitized,
        status,
        capturedAt,
        capturedAmount,
        ...response,
        paymentId: generatedPaymentId
      });

      const saveP = doc.save();
      if (FEATURE_ASYNC_PERSIST) {
        setImmediate(async () => { try { await withTimeout(saveP, PERSIST_TIMEOUT_MS, 'mongo-save-fast'); } catch (e) { logger.warn('save fast async', { e: e.message }); } });
      } else {
        try { await withTimeout(saveP, PERSIST_TIMEOUT_MS, 'mongo-save-fast'); } catch (e) { logger.warn('save fast sync', { e: e.message }); }
      }
      clearTimeout(hardAbortTimer);
      res.status(201).json({
        success: true,
        message: res.getMessage('transaction.created'),
        transaction: { ...doc.toObject(), _persist: FEATURE_ASYNC_PERSIST ? 'async' : 'sync' }
      });
      try {
        if (doc.callbackUrl && process.env.WEBHOOK_SECRET) {
          webhookDispatcher.enqueue({
            paymentId: doc.paymentId,
            merchantId: doc.merchantId,
            url: doc.callbackUrl,
            payload: {
              event: 'payment.updated',
              version: 'v1',
              data: {
                paymentId: doc.paymentId,
                merchantId: doc.merchantId,
                status: doc.status,
                amount: doc.amount,
                currency: doc.currency,
                connectorUsed: 'fast-sim',
                reasonCode: null,
                timestamp: nowIso(),
                cardInfo: null
              }
            }
          });
        }
      } catch {}
      return;
    }

    // Recurrencia básica
    let recurrenceId = value.recurrenceId || null;
    let token        = value.token        || null;

    if (value.transactionType === 'CIT' && value.isRecurring) {
      recurrenceId = uuidv4();
      token = await createTokenForCard({
        cardNumber:      value.cardNumber,
        cardholderName:  value.cardholderName,
        expiryMonth:     value.expiryMonth,
        expiryYear:      value.expiryYear,
        cvv:             value.cvv
      });

      const rp = new RecurrentProfile({
        recurrenceId, token, merchantId: value.merchantId,
        cardholderName: value.cardholderName, expiryMonth: value.expiryMonth, expiryYear: value.expiryYear
      });
      await withTimeout(rp.save(), DB_QUERY_TIMEOUT_MS, 'mongo-save-recurrent');
    }

    if (value.transactionType === 'MIT') {
      const findPrevP = Transaction.findOne({
        recurrenceId:  value.recurrenceId,
        token:         value.token,
        transactionType: 'CIT'
      });
      const previous = await withTimeout(findPrevP, DB_QUERY_TIMEOUT_MS, 'mongo-find-previous');
      if (!previous) {
        logger.warn('MIT sin CIT previa vinculada', { recurrenceId: value.recurrenceId, token: value.token });
        auditLogger.info({
          action: 'MIT_WITHOUT_CIT',
          user: req.merchantId || 'unknown',
          details: { recurrenceId: value.recurrenceId, token: value.token },
          metadata: { ip: req.ip, method: req.method, url: req.originalUrl }
        });
        clearTimeout(hardAbortTimer);
        return res.status(400).json({ success: false, message: res.getMessage('transaction.invalid.mit.noMatch') });
      }
    }

    // Sanitizar
    const sanitizedValue = { ...value };
    delete sanitizedValue.cvv; delete sanitizedValue.cardNumber;
    if (value.returnUrl)   sanitizedValue.returnUrl   = value.returnUrl;
    if (value.callbackUrl) sanitizedValue.callbackUrl = value.callbackUrl;

    // BIN enrichment
    let cardInfo = null;
    if (value.method === 'card' && value.cardNumber) {
      try {
        const parseP = parseBin(value.cardNumber);
        cardInfo = BIN_OFFLINE ? await parseP : await withTimeout(parseP, 1200, 'bin-lookup');
      } catch { cardInfo = null; }
    }

    // Orquestación
    let selectedConnector = 'defaultCardAcquirer';
    try {
      selectedConnector = await withTimeout(
        Promise.resolve(selectConnector({ ...value, cardInfo })),
        800,
        'select-connector'
      );
    } catch (e) {
      logger.warn('selectConnector timeout/fallback → defaultCardAcquirer', { err: e.message });
      selectedConnector = 'defaultCardAcquirer';
    }

    // Ejecución
    let response;
    let qrCodeImage = null;

    if (value.method === 'card') {
      const execP = executeCardPayment({ paymentRequest: value, paymentId: generatedPaymentId, primaryConnector: selectedConnector });
      response = await withTimeout(execP, Math.max(800, TX_TIMEOUT_MS - 2000), 'execute-card');
    } else {
      switch (selectedConnector) {
        case 'mbwayConnector':
          response = await withTimeout(mbwayConnector.process(value), Math.max(800, TX_TIMEOUT_MS - 2000), 'exec-mbway');
          break;
        case 'bizumConnector':
          response = await withTimeout(initiateBizumPayment(value), Math.max(800, TX_TIMEOUT_MS - 2000), 'exec-bizum');
          break;
        case 'pixConnector': {
          const pixP = initiatePixPayment(value);
          response = await withTimeout(pixP, Math.max(800, TX_TIMEOUT_MS - 2000), 'exec-pix');
          sanitizedValue.qrCodePayload = response.qrCodePayload;
          sanitizedValue.paymentUrl    = response.paymentUrl;
          qrCodeImage = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(response.qrCodePayload)}`;
          break;
        }
        case 'visaAcquirer':
          response = await withTimeout(visaAcquirer.initiatePayment(value),   Math.max(800, TX_TIMEOUT_MS - 2000), 'exec-visa');
          break;
        case 'mcAcquirer':
          response = await withTimeout(mcAcquirer.initiatePayment(value),     Math.max(800, TX_TIMEOUT_MS - 2000), 'exec-mc');
          break;
        case 'amexAcquirer':
          response = await withTimeout(amexAcquirer.initiatePayment(value),   Math.max(800, TX_TIMEOUT_MS - 2000), 'exec-amex');
          break;
        case 'defaultCardAcquirer':
          response = await withTimeout(defaultCardAcquirer.initiatePayment(value), Math.max(800, TX_TIMEOUT_MS - 2000), 'exec-default');
          break;
        default:
          throw new Error(`Unsupported connector: ${selectedConnector}`);
      }
    }

    // Persistencia + Autocapture (SALE)
    let finalStatus = response.status;
    let capturedAt = undefined;
    let capturedAmount = undefined;

    if (value.captureNow === true && value.method === 'card' && response.status === 'approved') {
      // Autocaptura en el mismo mensaje
      finalStatus = 'captured';
      capturedAt = nowIso();
      capturedAmount = value.amount;
    }

    sanitizedValue.status        = finalStatus;
    sanitizedValue.processor     = response.processor;
    sanitizedValue.transactionId = response.transactionId;
    if (response.authCode)   sanitizedValue.authCode   = response.authCode;
    if (response.timestamp)  sanitizedValue.timestamp  = response.timestamp;
    if (cardInfo)            sanitizedValue.cardInfo   = cardInfo;
    if (capturedAt)          sanitizedValue.capturedAt = capturedAt;
    if (capturedAmount)      sanitizedValue.capturedAmount = capturedAmount;

    const docToSave = new Transaction({
      ...sanitizedValue,
      paymentId:   generatedPaymentId,
      recurrenceId,
      token
    });

    const saveP = docToSave.save();
    if (!FEATURE_ASYNC_PERSIST) {
      await withTimeout(saveP, PERSIST_TIMEOUT_MS, 'mongo-save');
    } else {
      setImmediate(async () => {
        try { await withTimeout(saveP, PERSIST_TIMEOUT_MS, 'mongo-save-async'); logger.info('Persistencia async OK', { paymentId: generatedPaymentId }); }
        catch (e) { logger.error('Persistencia async FAILED', { paymentId: generatedPaymentId, error: e.message }); }
      });
    }

    clearTimeout(hardAbortTimer);
    res.status(finalStatus === 'approved' || finalStatus === 'captured' ? 201 : 402).json({
      success:       finalStatus === 'approved' || finalStatus === 'captured',
      message:       res.getMessage(finalStatus === 'declined' ? 'transaction.declined' : 'transaction.created'),
      transaction:   { ...docToSave.toObject(), _persist: FEATURE_ASYNC_PERSIST ? 'async' : 'sync' },
      recurrenceId,
      token,
      qrCodeImage
    });

    // Webhook (async)
    try {
      const callbackUrl = docToSave.callbackUrl;
      if (callbackUrl && process.env.WEBHOOK_SECRET) {
        const payload = {
          event: 'payment.updated',
          version: 'v1',
          data: {
            paymentId: docToSave.paymentId,
            merchantId: docToSave.merchantId,
            status: docToSave.status,
            amount: docToSave.amount,
            currency: docToSave.currency,
            connectorUsed: selectedConnector,
            reasonCode: response.reasonCode || null,
            timestamp: nowIso(),
            cardInfo: cardInfo ? {
              bin: cardInfo.bin || null,
              cardBrand: cardInfo.cardBrand || null,
              cardType: cardInfo.cardType || null,
              issuerCountry: cardInfo.issuerCountry || null
            } : null
          }
        };
        webhookDispatcher.enqueue({ paymentId: docToSave.paymentId, merchantId: docToSave.merchantId, url: callbackUrl, payload });
      }
    } catch (e) {
      logger.warn('Webhook enqueue error', { error: e.message });
    }

  } catch (err) {
    clearTimeout(hardAbortTimer);
    const isTimeout = String(err?.message || '').startsWith('timeout:');
    if (isTimeout) {
      logger.error('Timeout controlado en TX', { step: err.message });
      return res.status(504).json({ success: false, error: 'timeout', message: `Paso lento: ${err.message}` });
    }
    logger.error('Error al crear transacción', { error: err.message });
    auditLogger.info({
      action: 'TRANSACTION_CREATE_ERROR',
      user:   req.merchantId || 'unknown',
      details:{ error: err.message },
      metadata:{ ip: req.ip, method: req.method, url: req.originalUrl }
    });
    return res.status(500).json({ success: false, message: res.getMessage('transaction.create.error') });
  }
};

/* --------------------------------------------------------------------------- */
const getTransactionById = async (req, res) => {
  try {
    const { paymentId } = req.params;
    const findP = Transaction.findOne({ paymentId });
    const transaction = await withTimeout(findP, DB_QUERY_TIMEOUT_MS, 'mongo-find-by-id');
    if (!transaction) {
      logger.warn('Transacción no encontrada', { paymentId });
      return res.status(404).json({ success: false, message: res.getMessage('transaction.not.found') });
    }
    logger.info('Transacción obtenida por ID', { paymentId });
    res.status(200).json({ success: true, transaction });
  } catch (err) {
    logger.error('Error al obtener transacción', { error: err.message });
    res.status(500).json({ success: false, message: res.getMessage('transaction.fetch.error') });
  }
};

/* --------------------------------------------------------------------------- */
const updateTransaction = async (req, res) => {
  try {
    const { paymentId } = req.params;
    const updates = req.body;
    const updP = Transaction.findOneAndUpdate(
      { paymentId },
      { $set: updates },
      { new: true }
    );
    const transaction = await withTimeout(updP, DB_QUERY_TIMEOUT_MS, 'mongo-update');
    if (!transaction) {
      logger.warn('Transacción no encontrada para actualizar', { paymentId });
      return res.status(404).json({ success: false, message: res.getMessage('transaction.not.found') });
    }
    logger.info('Transacción actualizada', { paymentId, updates });
    res.status(200).json({ success: true, message: res.getMessage('transaction.updated'), transaction });
  } catch (err) {
    logger.error('Error al actualizar transacción', { error: err.message });
    res.status(500).json({ success: false, message: res.getMessage('transaction.update.error') });
  }
};

const deleteTransaction = async (req, res) => {
  try {
    const { paymentId } = req.params;
    const delP = Transaction.findOneAndDelete({ paymentId });
    const deleted = await withTimeout(delP, DB_QUERY_TIMEOUT_MS, 'mongo-delete');
    if (!deleted) {
      logger.warn('Transacción no encontrada para eliminar', { paymentId });
      return res.status(404).json({ success: false, message: res.getMessage('transaction.not.found') });
    }
    logger.info('Transacción eliminada', { paymentId });
    res.status(200).json({ success: true, message: res.getMessage('transaction.deleted') });
  } catch (err) {
    logger.error('Error al eliminar transacción', { error: err.message });
    res.status(500).json({ success: false, message: res.getMessage('transaction.delete.error') });
  }
};

const getTransactionVolume = async (req, res) => {
  try {
    const aggP = Transaction.aggregate([
      { $match: { status: 'approved' } },
      { $group: { _id: null, totalVolume: { $sum: '$amount' } } }
    ]);
    const result = await withTimeout(aggP, DB_QUERY_TIMEOUT_MS, 'mongo-agg-volume');
    const totalVolume = result[0]?.totalVolume || 0;
    logger.info('Volumen total obtenido', { totalVolume });
    res.status(200).json({ totalVolume });
  } catch (err) {
    logger.error('Error al obtener volumen', { error: err.message });
    res.status(500).json({ success: false, message: res.getMessage('transaction.analytics.volume.error') });
  }
};

const getApprovalRate = async (req, res) => {
  try {
    const totalP    = Transaction.countDocuments();
    const approvedP = Transaction.countDocuments({ status: 'approved' });
    const [total, approved] = await Promise.all([
      withTimeout(totalP, DB_QUERY_TIMEOUT_MS, 'mongo-count-all'),
      withTimeout(approvedP, DB_QUERY_TIMEOUT_MS, 'mongo-count-approved')
    ]);
    const rate = total ? ((approved / total) * 100).toFixed(2) : '0';
    logger.info('Tasa de aprobación obtenida', { total, approved, rate });
    res.status(200).json({ approvalRate: `${rate}%` });
  } catch (err) {
    logger.error('Error al obtener tasa aprobación', { error: err.message });
    res.status(500).json({ success: false, message: res.getMessage('transaction.analytics.approvalRate.error') });
  }
};

const getAverageMSC = async (req, res) => {
  try {
    const aggP = Transaction.aggregate([
      { $match: { status: 'approved' } },
      { $group: { _id: null, average: { $avg: '$amount' } } }
    ]);
    const result = await withTimeout(aggP, DB_QUERY_TIMEOUT_MS, 'mongo-agg-avg');
    const averageMSC = result[0]?.average || 0;
    logger.info('MSC promedio obtenido', { averageMSC });
    res.status(200).json({ averageMSC });
  } catch (err) {
    logger.error('Error al obtener MSC promedio', { error: err.message });
    res.status(500).json({ success: false, message: res.getMessage('transaction.analytics.averageMsc.error') });
  }
};

const getTransactionSummary = async (req, res) => {
  try {
    const totalP    = Transaction.countDocuments();
    const approvedP = Transaction.countDocuments({ status: 'approved' });
    const declinedP = Transaction.countDocuments({ status: 'declined' });
    const volumeP   = Transaction.aggregate([
      { $match: { status: 'approved' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);
    const [total, approved, declined, volumeRes] = await Promise.all([
      withTimeout(totalP, DB_QUERY_TIMEOUT_MS, 'mongo-count-all2'),
      withTimeout(approvedP, DB_QUERY_TIMEOUT_MS, 'mongo-count-appr2'),
      withTimeout(declinedP, DB_QUERY_TIMEOUT_MS, 'mongo-count-decl2'),
      withTimeout(volumeP, DB_QUERY_TIMEOUT_MS, 'mongo-agg-vol2')
    ]);
    const volume = volumeRes[0]?.total || 0;

    logger.info('Resumen de métricas obtenido', { total, approved, declined, volume });
    res.status(200).json({
      totalTransactions:     total,
      approvedTransactions:  approved,
      declinedTransactions:  declined,
      approvalRate:          total ? ((approved / total) * 100).toFixed(2) + '%' : '0%',
      totalVolume:           volume
    });
  } catch (err) {
    logger.error('Error al obtener resumen de métricas', { error: err.message });
    res.status(500).json({ success: false, message: res.getMessage('transaction.analytics.summary.error') });
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
