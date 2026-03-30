// src/routes/webhooks.js
'use strict';

const express = require('express');
const router  = express.Router();
const { handlePayNoPainWebhook } = require('../controllers/webhookController');

/**
 * POST /webhooks/paynopain
 * Recibe notificaciones de Paylands cuando un pago finaliza.
 * No requiere autenticación por API key — usa validación por hash interno.
 */
router.post('/paynopain', handlePayNoPainWebhook);

module.exports = router;
