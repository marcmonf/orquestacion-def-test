// ✅ src/middleware/validateTokenApiKey.js (versión robusta)
const getMessage = require('../i18n/getMessage');

module.exports = (req, res, next) => {
  const tokenApiKey = req.headers['x-api-key'];
  const langHeader = req.headers['accept-language'];
  const lang = langHeader?.split(',')[0]?.split('-')[0]?.trim().toLowerCase() || 'en';

  if (!tokenApiKey || tokenApiKey !== process.env.TOKEN_API_KEY) {
    return res.status(403).json({
      success: false,
      message: getMessage(lang, 'error.invalidApiKey')
    });
  }

  next();
};
