// GET /analytics/evolution - Evolución temporal de transacciones
router.get('/evolution', async (req, res) => {
  const { period = 'daily', startDate, endDate, method } = req.query;

  // Validaciones mínimas de fechas
  if (!startDate || !endDate) {
    return res.status(400).json({ error: 'Debes especificar startDate y endDate' });
  }

  // Formato de fechas esperado: YYYY-MM-DD
  const start = new Date(startDate);
  const end = new Date(endDate);
  end.setHours(23, 59, 59, 999); // incluir todo el día

  // Selección del campo de agrupación
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

  // Filtro base
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

    // Adaptar salida según agrupación semanal
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
