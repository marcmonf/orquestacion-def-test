// index.js
const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const helmet = require('helmet'); // ✅ importamos Helmet

const errorHandler = require('./src/middleware/errorHandler');
const rateLimiter = require('./src/middleware/rateLimiter');
const rateLimiterTokens = require('./src/middleware/rateLimiterTokens');
const rateLimiterWebhooks = require('./src/middleware/rateLimiterWebhooks');
const i18nMiddleware = require('./src/i18n/i18nMiddleware');
const getMessage = require('./src/i18n/getMessage');

dotenv.config();
const app = express();

// Permitir uso de X-Forwarded-For en entornos con proxy (ej: Render)
app.set('trust proxy', 1);

// Conexión a MongoDB
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log('MongoDB conectado'))
.catch(err => console.error('Error de conexión MongoDB:', err));

// Middlewares globales
app.use(helmet()); // ✅ Usamos Helmet antes de cualquier otra cosa
app.use(express.json());
app.use(i18nMiddleware);

// Middleware de validación de API Key
const validateApiKey = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  const langHeader = req.headers['accept-language'];
  const lang = langHeader?.split(',')[0]?.split('-')[0]?.trim().toLowerCase() || 'en';

  if (!apiKey || apiKey !== process.env.API_KEY) {
    return res.status(403).json({ error: getMessage(lang, 'error.invalidApiKey') });
  }

  next();
};

// Rutas protegidas
app.use('/apms',         validateApiKey, rateLimiter,         require('./src/channels/apms/apmsHandler'));
app.use('/transactions', validateApiKey, rateLimiter,         require('./src/routes/transactions'));
app.use('/tokens',       validateApiKey, rateLimiterTokens,   require('./src/tokens/tokenRoutes'));
app.use('/analytics',    validateApiKey, rateLimiter,         require('./src/routes/analytics'));
app.use('/merchants',    validateApiKey, rateLimiter,         require('./src/routes/merchantRoutes'));

// Ruta de prueba
app.use('/test', require('./src/routes/testRoutes'));

// Rutas públicas
app.use('/webhooks', rateLimiterWebhooks, require('./src/routes/webhooks'));
app.use('/webhooks', require('./src/webhooks/webhookReceiver')); // pública sin rate limit

// Middleware de errores (último siempre)
app.use(errorHandler);

// Lanzar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Pasarela escuchando en puerto ${PORT}`);
});
