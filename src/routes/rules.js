'use strict';

const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/rulesController');

// *** Rutas SIN parámetro primero (para evitar colisiones) ***
router.get('/rules/export', ctrl.exportPolicy);     // ?merchantId=demo-merchant
router.post('/rules/import', ctrl.importPolicy);
router.post('/rules/try', ctrl.tryPolicy);

// *** Rutas con parámetro ***
router.get('/rules/:merchantId', ctrl.getPolicy);
router.put('/rules/:merchantId', ctrl.upsertPolicy);
router.get('/rules/:merchantId/audit', ctrl.getAudit);

// Validación explícita (si la usas)
router.post('/rules/validate', ctrl.validatePolicy);

module.exports = router;
