'use strict';
const express = require('express');
const router = express.Router();
const adminAuth = require('../middleware/adminAuth');
const { getPolicy, validatePolicy, upsertPolicy } = require('../controllers/rulesController');

// GET /rules/:merchantId
router.get('/:merchantId', adminAuth, getPolicy);

// POST /rules/validate
router.post('/validate', adminAuth, validatePolicy);

// PUT /rules/:merchantId
router.put('/:merchantId', adminAuth, upsertPolicy);

module.exports = router;
