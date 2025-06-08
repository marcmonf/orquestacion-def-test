// src/routes/pmsRoutes.js
const express = require('express');
const router = express.Router();
const { fetchAndStoreCloudbedsReservations } = require('../controllers/pmsController');
const apiKeyAuth = require('../middleware/auth');

router.get('/cloudbeds/fetch-reservations', apiKeyAuth, fetchAndStoreCloudbedsReservations);

module.exports = router;
