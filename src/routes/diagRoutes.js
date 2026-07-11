// src/routes/diagRoutes.js
//
// Endpoint de DIAGNÓSTICO (solo lectura) para inspeccionar el estado real de las
// transacciones en Mongo sin entrar a Atlas. Protegido por X-Admin-Token.
//
// Seguridad: proyección explícita de campos NO sensibles. Nunca devuelve datos de
// tarjeta (cardholderName, expiry...), secretos ni callbackUrl. Solo estados y
// referencias necesarias para diagnosticar el flujo de pagos/webhooks.
//
// Uso: GET /diag/transactions?limit=50[&status=hosted_pending][&paymentId=...]
//
'use strict';

const express   = require('express');
const router    = express.Router();
const Transaction = require('../models/Transaction');
const adminAuth   = require('../middleware/adminAuth');

router.use(adminAuth);

// Campos de diagnóstico permitidos (whitelist estricta)
const DIAG_PROJECTION = {
  _id: 0,
  paymentId: 1,
  merchantId: 1,
  status: 1,
  amount: 1,
  currency: 1,
  method: 1,
  processorReference: 1,   // ← orderUuid Paylands (clave para el webhook)
  authCode: 1,             // ← donde por error se guardaba el orderUuid
  processor: 1,
  hostedCheckoutId: 1,
  merchantReference: 1,
  bin: 1,
  cardBrand: 1,
  cardType: 1,
  issuerCountry: 1,
  createdAt: 1,
  updatedAt: 1,
};

// GET /diag/transactions
router.get('/transactions', async (req, res) => {
  try {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '50', 10)));
    const filter = {};
    if (req.query.status)    filter.status    = req.query.status;
    if (req.query.paymentId) filter.paymentId = req.query.paymentId;
    if (req.query.merchantId) filter.merchantId = req.query.merchantId;

    const [total, byStatus, txs] = await Promise.all([
      Transaction.countDocuments(filter),
      Transaction.aggregate([
        { $match: filter },
        { $group: { _id: '$status', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      Transaction.find(filter, DIAG_PROJECTION).sort({ createdAt: -1 }).limit(limit).lean(),
    ]);

    // Diagnóstico rápido: marcar transacciones "colgadas" (orderUuid mal ubicado)
    const analysis = txs.map(t => ({
      ...t,
      _diag: {
        hasProcessorRef: !!t.processorReference,
        orderUuidLikelyInAuthCode: !t.processorReference && !!t.authCode,
        stuck: t.status === 'hosted_pending',
        binPresent: !!t.bin,
      }
    }));

    res.status(200).json({
      total,
      countsByStatus: byStatus.reduce((acc, s) => { acc[s._id || 'null'] = s.count; return acc; }, {}),
      returned: analysis.length,
      transactions: analysis,
    });
  } catch (err) {
    res.status(500).json({ error: 'diag_error', detail: err.message });
  }
});

module.exports = router;
