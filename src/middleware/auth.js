require('dotenv').config();

function apiKeyAuth(req, res, next) {
  const apiKey = req.header('x-api-key');
  if (!apiKey || apiKey !== process.env.API_KEY) {
    return res.status(403).json({ message: 'Acceso denegado. API key inválida o ausente.' });
  }
  next();
}

module.exports = apiKeyAuth;
