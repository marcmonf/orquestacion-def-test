// src/routes/health.js
const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

router.get('/health', (req, res) => {
  const uptime = process.uptime(); // segundos
  const dbStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';

  res.status(200).json({
    status: 'ok',
    message: res.getMessage ? res.getMessage('health.ok') : 'API operational',
    uptime: `${Math.floor(uptime)}s`,
    mongodb: dbStatus,
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

module.exports = router;
