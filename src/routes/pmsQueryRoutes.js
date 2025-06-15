// src/routes/pmsQueryRoutes.js
const express = require('express');
const router = express.Router();
const { getUploadedReservations } = require('../controllers/pmsQueryController');

router.get('/reservations', getUploadedReservations);

module.exports = router;
