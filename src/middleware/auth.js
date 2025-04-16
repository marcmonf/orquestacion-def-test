const express = require('express');
const router = express.Router();
const { getAllTransactions } = require('../controllers/transactionController');
const apiKeyAuth = require('../middleware/auth');

router.get('/', apiKeyAuth, getAllTransactions);

module.exports = router;
