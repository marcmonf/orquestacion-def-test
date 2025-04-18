const express = require('express');
const router = express.Router();
const apiKeyAuth = require('../middleware/auth');
const { getAllTransactions, createTransaction } = require('../controllers/transactionController');

// GET /transactions - Listar con filtros y paginación
router.get('/', apiKeyAuth, getAllTransactions);

// POST /transactions - Crear nueva transacción
router.post('/', apiKeyAuth, createTransaction);

module.exports = router;
