// src/routes/iframe.js
const express = require('express');
const router = express.Router();
const axios = require('axios');
const getMessage = require('../i18n/getMessage');

router.post('/iframe-process', async (req, res) => {
  const langHeader = req.headers['accept-language'];
  const lang = langHeader?.split(',')[0]?.split('-')[0]?.trim().toLowerCase() || 'en';

  try {
    const response = await axios.post(`${process.env.ORQUESTADOR_URL}/transactions`, req.body, {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.API_KEY
      }
    });

    res.status(response.status).json(response.data);
  } catch (error) {
    console.error('Error forwarding request:', error.response?.data || error.message);
    res.status(500).json({
      success: false,
      message: getMessage(lang, 'transaction.create.error')
    });
  }
});

module.exports = router;
