const express = require('express');
const multer = require('multer');
const router = express.Router();

const {
  uploadReservationsFromCsv,
  getReservations
} = require('../controllers/pmsUploadController');

const apiKeyAuth = require('../middleware/auth');
const checkRole = require('../middleware/checkRole');
const rateLimiter = require('../middleware/rateLimiter');
const rateLimiterPms = require('../middleware/rateLimiterPms');

const validateReservationQuery = require('../validators/pmsReservationQueryValidator');

// Configuración actualizada para multer@2
const storage = multer.memoryStorage();
const upload = multer({ storage }).single('file');

router.post(
  '/upload-reservations',
  apiKeyAuth,
  checkRole(['admin']),
  rateLimiter,
  upload,
  uploadReservationsFromCsv
);

router.get(
  '/reservations',
  apiKeyAuth,
  checkRole(['admin', 'superuser']),
  rateLimiterPms,
  validateReservationQuery,
  getReservations
);

module.exports = router;
