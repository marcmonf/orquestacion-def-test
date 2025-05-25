// src/routes/iframe.js
const express = require('express');
const router = express.Router();
const axios = require('axios');
const getMessage = require('../i18n/getMessage');

router.post('/', async (req, res) => {
  const langHeader = req.headers['accept-language'];
  const lang = langHeader?.split(',')[0]?.split('-')[0]?.trim().toLowerCase() || 'en';

  const ORQUESTADOR_URL = process.env.ORQUESTADOR_URL;
  const API_KEY = process.env.API_KEY;

  if (!ORQUESTADOR_URL || !API_KEY) {
    console.error('❌ ORQUESTADOR_URL o API_KEY no definidas en las variables de entorno');
    return res.status(500).json({
      success: false,
      message: getMessage(lang, 'error.internal')
    });
  }

  try {
    const response = await axios.post(`${ORQUESTADOR_URL}/transactions`, req.body, {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY
      }
    });

    res.status(response.status).json(response.data);
  } catch (error) {
    console.error('❌ Error al reenviar desde /iframe-process:', error.response?.data || error.message);
    res.status(500).json({
      success: false,
      message: getMessage(lang, 'transaction.create.error')
    });
  }
});

module.exports = router;
