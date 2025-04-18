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

    const totalVolume = await Transaction.aggregate([
      { $group: { _id: null, total: { $sum: "$amount" } } }
    ]);

    const approvalRate = totalTxs ? (approvedTxs / totalTxs) * 100 : 0;
    const fallbackRate = totalTxs ? (fallbackTxs / totalTxs) * 100 : 0;

    res.status(200).json({
      total: totalTxs,
      totalVolume: totalVolume[0]?.total || 0,
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

// GET /analytics/evolution - Evolución temporal de transacciones
router.get('/evolution', async (req, res) => {
  const { period = 'daily', startDate, endDate, method } = req.query;

  if (!startDate || !endDate) {
    return res.status(400).json({ error: 'Debes especificar startDate y endDate' });
  }

  const start = new Date(startDate);
  const end = new Date(endDate);
  end.setHours(23, 59, 59, 999);

  let dateFormat;
  switch (period) {
    case 'monthly':
      dateFormat = { $dateToString: { format: "%Y-%m", date: "$createdAt" } };
      break;
    case 'weekly':
      dateFormat = { $isoWeek: "$createdAt" };
      break;
    case 'daily':
    default:
      dateFormat = { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } };
      break;
  }

  const match = {
    createdAt: { $gte: start, $lte: end }
  };

  if (method) {
    match.method = method;
  }

  try {
    const data = await Transaction.aggregate([
      { $match: match },
      {
        $group: {
          _id: dateFormat,
          total: { $sum: 1 },
          volume: { $sum: "$amount" }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    const results = data.map(item => ({
      [period === 'weekly' ? 'week' : 'date']: item._id,
      total: item.total,
      volume: item.volume
    }));

    res.status(200).json(results);
  } catch (err) {
    console.error('Error en analytics/evolution:', err);
    res.status(500).json({ error: 'Error al calcular la evolución temporal' });
  }
});

module.exports = router;
