const express = require('express');
const router = express.Router();
const Transaction = require('../models/Transaction'); // Asegúrate de que esta ruta sea correcta

// GET /transactions - Listar todas las transacciones
router.get('/', async (req, res) => {
  try {
    const transactions = await Transaction.find().sort({ createdAt: -1 });
    res.status(200).json(transactions);
  } catch (error) {
    console.error('Error al obtener transacciones:', error);
    res.status(500).json({ message: 'Error al obtener transacciones' });
  }
});

module.exports = router;
