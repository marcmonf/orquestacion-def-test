// src/routes/pmsUploadRoutes.js
const express = require('express');
const multer = require('multer');
const router = express.Router();

const { uploadReservationsFromCsv } = require('../controllers/pmsUploadController');
const apiKeyAuth = require('../middleware/auth');
const checkRole = require('../middleware/checkRole');
const rateLimiter = require('../middleware/rateLimiter');

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

module.exports = router;
