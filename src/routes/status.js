// src/routes/status.js
'use strict';
//
// Salud y estado (F2, nov 2026).
//   GET /health/ready  → 200 si este proceso puede servir pagos (Mongo responde,
//                         worker de webhooks en marcha, entorno coherente); 503 si no.
//                         (/health sigue siendo el "estoy vivo" de siempre.)
//   GET /status.json   → estado público agregado (cacheado 30 s).
//   GET /status        → página pública de estado (public/status.html).
// Sin datos de comercios, pagos ni secretos.

const express = require('express');
const path = require('path');
const router = express.Router();
const statusService = require('../services/statusService');

router.get('/health/ready', async (req, res) => {
  try {
    const r = await statusService.readiness();
    return res.status(r.ready ? 200 : 503).json(r);
  } catch (_) {
    return res.status(503).json({ ready: false, issues: ['readiness_check_failed'] });
  }
});

router.get('/status.json', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'public, max-age=30');
    return res.json(await statusService.snapshot());
  } catch (_) {
    return res.status(503).json({ status: 'unknown' });
  }
});

router.get('/status', (req, res) => {
  res.sendFile(path.join(__dirname, '../../public/status.html'));
});

module.exports = router;
