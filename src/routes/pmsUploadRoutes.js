// src/routes/pmsUploadRoutes.js
const express = require('express');
const multer = require('multer');
const router = express.Router();

const { uploadReservationsFromCsv } = require('../controllers/pmsUploadController');
const apiKeyAuth = require('../middleware/auth');
const checkRole = require('../middleware/checkRole');
const rateLimiter = require('../middleware/rateLimiter');

const upload = multer({ storage: multer.memoryStorage() });

router.post(
  '/upload-reservations',
  apiKeyAuth,
  checkRole(['admin']),
  rateLimiter,
  upload.single('file'),
  uploadReservationsFromCsv
);

module.exports = router;
