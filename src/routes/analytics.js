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

    res.status(200).json({
      total: totalTxs,
      approved: approvedTxs,
      rejected: rejectedTxs,
      fallbackUsed: fallbackTxs
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
