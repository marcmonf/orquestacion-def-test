'use strict';
const express = require('express');
const router = express.Router();
const { decideRoute } = require('../controllers/orchestrationController');

// Auth opcional por ENV, igual patrón que initialize
let apiKeyAuth = (req, res, next) => next();
if (String(process.env.ORCHESTRATION_REQUIRE_API_KEY).toLowerCase() === 'true') {
  try { apiKeyAuth = require('../middleware/auth'); } catch {}
}

// POST /orchestration/decide
router.post('/decide', apiKeyAuth, decideRoute);

module.exports = router;
