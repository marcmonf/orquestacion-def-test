// src/routes/serverPaymentRoutes.js
'use strict';

const express = require('express');
const router = express.Router();
const {
  createServerPayment,
  getServerPaymentStatus
} = require('../controllers/serverPaymentController');

// Auth opcional, mismo patrón que el resto de rutas
let apiKeyAuth = (req, res, next) => next();
if (String(process.env.SERVER_TO_SERVER_REQUIRE_API_KEY).toLowerCase() === 'true') {
  try {
    apiKeyAuth = require('../middleware/auth');
  } catch {
    // Si no existe el middleware, seguimos sin auth para no romper nada
  }
}

// POST /payments/server
router.post('/', apiKeyAuth, createServerPayment);

// GET /payments/server/:paymentId
router.get('/:paymentId', apiKeyAuth, getServerPaymentStatus);

module.exports = router;
