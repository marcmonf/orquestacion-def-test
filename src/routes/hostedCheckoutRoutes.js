// src/routes/hostedCheckoutRoutes.js
'use strict';

const express = require('express');
const router = express.Router();
const {
  createHostedCheckout,
  getHostedCheckoutStatus
} = require('../controllers/hostedCheckoutController');

// Auth opcional, mismo patrón que el resto de rutas
let apiKeyAuth = (req, res, next) => next();
if (String(process.env.HOSTED_CHECKOUT_REQUIRE_API_KEY).toLowerCase() === 'true') {
  try {
    apiKeyAuth = require('../middleware/auth');
  } catch {
    // Si no existe el middleware, seguimos sin auth para no romper nada
  }
}

// POST /payments/hosted
router.post('/', apiKeyAuth, createHostedCheckout);

// GET /payments/hosted/:hostedCheckoutId/status
router.get('/:hostedCheckoutId/status', apiKeyAuth, getHostedCheckoutStatus);

module.exports = router;
