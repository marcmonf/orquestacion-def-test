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

/* ------------ NUEVOS FLAGS / TIMEOUTS (sin romper por defecto) ------------- */
const TX_TIMEOUT_MS = Math.max(1000, parseInt(process.env.TX_TIMEOUT_MS || '8000', 10));
const FEATURE_ASYNC_PERSIST = process.env.FEATURE_ASYNC_PERSIST === '1'; // responde antes y persiste en background
const PERSIST_TIMEOUT_MS = Math.max(500, Math.min(5000, parseInt(process.env.PERSIST_TIMEOUT_MS || '3000', 10))); // cap al guardado
const BIN_OFFLINE = process.env.BIN_OFFLINE === '1';

/* util pequeño para acotar promesas con timeout */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout:${label}`)), ms);
    promise
      .then((v) => { clearTimeout(t); resolve(v); })
      .catch((e) => { clearTimeout(t); reject(e); });
  });
}

/* ---------------------------------------------------------------------------
   GET /transactions
--------------------------------------------------------------------------- */
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
      Transaction.countDocuments(query),
      Transaction.find(query).sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit))
    ]);

    logger.info('Transacciones obtenidas', { total, query });
    res.status(200).json({ page: parseInt(page), limit: parseInt(limit), total, transactions });
  } catch (error) {
    logger.error('Error al obtener transacciones', { error: error.message });
    res.status(500).json({ success: false, message: res.getMessage('transaction.fetch.error') });
  }
};

/* ---------------------------------------------------------------------------
   POST /transactions
--------------------------------------------------------------------------- */
const createTransaction = async (req, res) => {
  // Validación
  const { error, value } = transactionSchema.validate(req.body);
  if (error) {
    const messageKey = error.details[0].message;
    const translated = res.getMessage?.(messageKey) || messageKey || 'transaction.validation';
    logger.warn('Validación fallida en creación', { details: messageKey });
    auditLogger.info({
      action: 'TRANSACTION_VALIDATION_FAILED',
      user: req.merchantId || 'unknown',
      details: { error: messageKey },
      metadata: { ip: req.ip, method: req.method, url: req.originalUrl }
    });
    return res.status(400).json({ success: false, message: translated });
  }

  // Límite de seguridad de la petición completa (por si algo se atasca)
  const hardAbortTimer = setTimeout(() => {
    logger.error('TX hard timeout alcanzado', { merchantId: value.merchantId, amount: value.amount });
    try { res.status(504).json({ success: false, error: 'timeout', message: `No respuesta en ${TX_TIMEOUT_MS}ms` }); } catch {}
  }, TX_TIMEOUT_MS);

  try {
    const generatedPaymentId = uuidv4();

    // Recurrencia CIT/MIT mínima
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

      await new RecurrentProfile({
        recurrenceId,
        token,
        merchantId:      value.merchantId,
        cardholderName:  value.cardholderName,
        expiryMonth:     value.expiryMonth,
        expiryYear:      value.expiryYear
      }).save();
    }

    if (value.transactionType === 'MIT') {
      const previous = await Transaction.findOne({
        recurrenceId:  value.recurrenceId,
        token:         value.token,
        transactionType: 'CIT'
      });
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

    // Sanitizar input y extra
    const sanitizedValue = { ...value };
    delete sanitizedValue.cvv;
    delete sanitizedValue.cardNumber;
    if (value.returnUrl)   sanitizedValue.returnUrl = value.returnUrl;
    if (value.callbackUrl) sanitizedValue.callbackUrl = value.callbackUrl;

    // BIN enrichment rápido / offline-friendly
    let cardInfo = null;
    if (value.method === 'card' && value.cardNumber) {
      try {
        // Si BIN_OFFLINE=1 tu parser ya retorna rápido; si no, proteger con timeout corto
        const parseP = parseBin(value.cardNumber);
        cardInfo = BIN_OFFLINE ? await parseP : await withTimeout(parseP, 1200, 'bin-lookup');
      } catch { cardInfo = null; }
    }

    // Orquestación
    const selectedConnector = await selectConnector({ ...value, cardInfo });
    logger.info(`🧠 Orchestrator selected connector: ${selectedConnector}`);
    auditLogger.info({
      action: 'ORCHESTRATION_DECISION',
      user: req.merchantId || 'unknown',
      details: { selectedConnector, method: value.method, merchantId: value.merchantId, cardScheme: value.cardScheme },
      metadata: { ip: req.ip, method: req.method, url: req.originalUrl }
    });

    // Ejecución (acotada por seguridad, aunque tus conectores ya son rápidos)
    let response;
    let qrCodeImage = null;

    if (value.method === 'card') {
      const execP = executeCardPayment({
        paymentRequest:   value,
        paymentId:        generatedPaymentId,
        primaryConnector: selectedConnector
      });
      response = await withTimeout(execP, Math.max(800, TX_TIMEOUT_MS - 2000), 'execute-card');
    } else {
      switch (selectedConnector) {
        case 'mbwayConnector':  response = await mbwayConnector.process(value); break;
        case 'bizumConnector':  response = await initiateBizumPayment(value);  break;
        case 'pixConnector':
          response = await initiatePixPayment(value);
          sanitizedValue.qrCodePayload = response.qrCodePayload;
          sanitizedValue.paymentUrl    = response.paymentUrl;
          qrCodeImage = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(response.qrCodePayload)}`;
          break;
        case 'visaAcquirer':    response = await visaAcquirer.initiatePayment(value);   break;
        case 'mcAcquirer':      response = await mcAcquirer.initiatePayment(value);     break;
        case 'amexAcquirer':    response = await amexAcquirer.initiatePayment(value);   break;
        case 'defaultCardAcquirer': response = await defaultCardAcquirer.initiatePayment(value); break;
        default: throw new Error(`Unsupported connector: ${selectedConnector}`);
      }
    }

    // Persistencia (dos modos: síncrono como siempre, o asíncrono si activas flag)
    sanitizedValue.status        = response.status;
    sanitizedValue.processor     = response.processor;
    sanitizedValue.transactionId = response.transactionId;
    if (response.authCode)   sanitizedValue.authCode   = response.authCode;
    if (response.timestamp)  sanitizedValue.timestamp  = response.timestamp;
    if (cardInfo)            sanitizedValue.cardInfo   = cardInfo;

    const docToSave = new Transaction({
      ...sanitizedValue,
      paymentId:   generatedPaymentId,
      recurrenceId,
      token
    });

    if (!FEATURE_ASYNC_PERSIST) {
      // Comportamiento original (síncrono), con protección de timeout para no llegar al 504 del proxy
      await withTimeout(docToSave.save(), PERSIST_TIMEOUT_MS, 'mongo-save');
    } else {
      // Persistencia asíncrona: la respuesta se envía ya y se guarda en background
      setImmediate(async () => {
        try {
          await docToSave.save();
          logger.info('Persistencia async OK', { paymentId: generatedPaymentId });
        } catch (e) {
          logger.error('Persistencia async FAILED', { paymentId: generatedPaymentId, error: e.message });
        }
      });
    }

    // RESPUESTA INMEDIATA (idéntico contrato)
    clearTimeout(hardAbortTimer);
    res.status(response.status === 'approved' ? 201 : 402).json({
      success:       response.status === 'approved',
      message:       res.getMessage(response.status === 'approved' ? 'transaction.created' : 'transaction.declined'),
      transaction:   {
        ...docToSave.toObject(),
        // Si es async persist, avisamos sutilmente del modo (no cambia el contrato)
        _persist: FEATURE_ASYNC_PERSIST ? 'async' : 'sync'
      },
      recurrenceId,
      token,
      qrCodeImage
    });

    // Webhook en background (NO bloquea)
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
            timestamp: new Date().toISOString(),
            cardInfo: cardInfo ? {
              bin: cardInfo.bin || null,
              cardBrand: cardInfo.cardBrand || null,
              cardType: cardInfo.cardType || null,
              issuerCountry: cardInfo.issuerCountry || null
            } : null
          }
        };
        // no await
        webhookDispatcher.enqueue({
          paymentId: docToSave.paymentId,
          merchantId: docToSave.merchantId,
          url: callbackUrl,
          payload
        });
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

/* ---------------------------------------------------------------------------
   GET /transactions/:paymentId
--------------------------------------------------------------------------- */
const getTransactionById = async (req, res) => {
  try {
    const { paymentId } = req.params;
    const transaction = await Transaction.findOne({ paymentId });
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

/* ---------------------------------------------------------------------------
   UPDATE / DELETE y analíticas (sin cambios)
--------------------------------------------------------------------------- */
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
    const deleted = await Transaction.findOneAndDelete({ paymentId });
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
    const result = await Transaction.aggregate([
      { $match: { status: 'approved' } },
      { $group: { _id: null, totalVolume: { $sum: '$amount' } } }
    ]);
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
    const total     = await Transaction.countDocuments();
    const approved  = await Transaction.countDocuments({ status: 'approved' });
    const rate      = total ? ((approved / total) * 100).toFixed(2) : '0';
    logger.info('Tasa de aprobación obtenida', { total, approved, rate });
    res.status(200).json({ approvalRate: `${rate}%` });
  } catch (err) {
    logger.error('Error al obtener tasa aprobación', { error: err.message });
    res.status(500).json({ success: false, message: res.getMessage('transaction.analytics.approvalRate.error') });
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
    res.status(500).json({ success: false, message: res.getMessage('transaction.analytics.averageMsc.error') });
  }
};

const getTransactionSummary = async (req, res) => {
  try {
    const total     = await Transaction.countDocuments();
    const approved  = await Transaction.countDocuments({ status: 'approved' });
    const declined  = await Transaction.countDocuments({ status: 'declined' });
    const volumeRes = await Transaction.aggregate([
      { $match: { status: 'approved' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
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
