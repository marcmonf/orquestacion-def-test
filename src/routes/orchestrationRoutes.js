'use strict';
const express = require('express');
const router = express.Router();
const adminAuth = require('../middleware/adminAuth');
const { decideRoute } = require('../controllers/orchestrationController');

// POST /orchestration/decide — herramienta INTERNA de diagnóstico del motor de
// reglas (X-Admin-Token).
//
// Antes su autenticación era opcional por ENV (ORCHESTRATION_REQUIRE_API_KEY,
// variable que no existe en Render) → endpoint PÚBLICO: devolvía la política de
// routing de cualquier merchant (reglas, BINs, umbrales, conectores) con el
// merchantId del body, y aceptaba un número de tarjeta completo. Mismo patrón que
// el /apms retirado el 16 jul 2026. Cerrado el 26 sep 2026.
router.post('/decide', adminAuth, decideRoute);

module.exports = router;
