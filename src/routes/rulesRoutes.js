'use strict';
const express = require('express');
const router = express.Router();
const adminAuth = require('../middleware/adminAuth');

const {
  getPolicy,
  validatePolicy,
  upsertPolicy,
  tryPolicy,
  getAudit,
  // NUEVO: export/import
  exportPolicy,
  importPolicy
} = require('../controllers/rulesController');

// *** RUTAS SIN PARÁMETROS (deben ir ANTES para evitar colisiones con :merchantId) ***

// Exporta política: GET /rules/export?merchantId=demo-merchant
router.get('/export', adminAuth, exportPolicy);

// Importa política: POST /rules/import
router.post('/import', adminAuth, importPolicy);

// Probar política en caliente: POST /rules/try
router.post('/try', adminAuth, tryPolicy);

// Validar estructura de política: POST /rules/validate
router.post('/validate', adminAuth, validatePolicy);

// *** RUTAS CON PARÁMETRO (después) ***

// Obtener política del merchant: GET /rules/:merchantId
router.get('/:merchantId', adminAuth, getPolicy);

// Upsert política del merchant: PUT /rules/:merchantId
router.put('/:merchantId', adminAuth, upsertPolicy);

// Auditoría de cambios: GET /rules/:merchantId/audit
router.get('/:merchantId/audit', adminAuth, getAudit);

module.exports = router;
