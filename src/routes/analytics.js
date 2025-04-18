// src/routes/analytics.js

const express = require('express');
const router = express.Router();
const Transaction = require('../models/Transaction');

// GET /analytics/summary - Resumen global
router.get('/summary', async (req, res) => {
  try {
    const totalTxs = await Transaction.countDocuments();
    const approvedTxs = await Transaction.countDocuments({ status: 'approved' });
    const rejectedTxs = await Transaction.countDocuments({ status: 'rejected' });
    const fallbackTxs = await Transaction.countDocuments({ fallbackUsed: true });

    const totalVolumeAgg = await Transaction.aggregate([
      { $group: { _id: null, total: { $sum: "$amount" } } }
    ]);
    const totalVolume = totalVolumeAgg[0]?.total || 0;

    const approvalRate = totalTxs > 0 ? (approvedTxs / totalTxs) * 100 : 0;
    const fallbackRate = totalTxs > 0 ? (fallbackTxs / totalTxs) * 100 : 0;

    res.status(200).json({
      total: totalTxs,
      totalVolume,
      approved: approvedTxs,
      rejected: rejectedTxs,
      approvalRate: `${approvalRate.toFixed(2)}%`,
      fallbackUsed: fallbackTxs,
      fallbackRate: `${fallbackRate.toFixed(2)}%`
    });
  } catch (err) {
    console.error('Error en analytics summary:', err);
    res.status(500).json({ error: 'Error al obtener estadísticas' });
  }
});

// GET /analytics/by-apm - Transacciones por APM
router.get('/by-apm', async (req, res) => {
  try {
    const result = await Transaction.aggregate([
      { $match: { processor: { $nin: ['simulator', 'backupSim'] } } },
      { $group: { _id: '$processor', total: { $sum: 1 } } },
      { $sort: { total: -1 } }
    ]);

    res.status(200).json(result);
  } catch (err) {
    console.error('Error en analytics por APM:', err);
    res.status(500).json({ error: 'Error al obtener estadísticas por APM' });
  }
});

module.exports = router;
