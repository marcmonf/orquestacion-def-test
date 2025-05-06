// src/middleware/auth.js
require('dotenv').config();
const getMessage = require('../i18n/getMessage');

function apiKeyAuth(req, res, next) {
  const apiKey = req.header('x-api-key');

  const langHeader = req.headers['accept-language'];
  const lang = langHeader?.split(',')[0]?.split('-')[0]?.trim().toLowerCase() || 'en';

  if (!apiKey || apiKey !== process.env.API_KEY) {
    return res.status(403).json({
      success: false,
      message: getMessage(lang, 'error.invalidApiKey')
    });
  }

  next();
}

module.exports = apiKeyAuth;
