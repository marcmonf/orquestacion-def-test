// index.js
const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const helmet = require('helmet');
const cors = require('cors');
const hpp = require('hpp');
const xss = require('xss-clean');
const mongoSanitize = require('express-mongo-sanitize');

const errorHandler = require('./src/middleware/errorHandler');
const notFoundHandler = require('./src/middleware/notFoundHandler');
const rateLimiter = require('./src/middleware/rateLimiter');
const rateLimiterTokens = require('./src/middleware/rateLimiterTokens');
const rateLimiterWebhooks = require('./src/middleware/rateLimiterWebhooks');
const i18nMiddleware = require('./src/i18n/i18nMiddleware');
const getMessage = require('./src/i18n/getMessage');

// ✅ Middleware específico para validar TOKEN_API_KEY
const validateApiKey = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  const langHeader = req.headers['accept-language'];
  const lang = langHeader?.split(',')[0]?.split('-')[0]?.trim().toLowerCase() || 'en';

  if (!apiKey || apiKey !== process.env.API_KEY) {
    return res.status(403).json({ error: getMessage(lang, 'error.invalidApiKey') });
  }

  next();
};

const validateTokenApiKey = require('./src/middleware/validateTokenApiKey');

dotenv.config();
const app = express();
app.set('trust proxy', 1);

// Conexión a MongoDB
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log('MongoDB conectado'))
.catch(err => console.error('Error de conexión MongoDB:', err));

// Middlewares globales de seguridad
app.use(helmet());
app.use(cors({
  origin: ['https://mi-frontend.com'], // 👈 cámbialo por tu dominio real
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
  credentials: true
}));
app.use(express.json({ limit: '10kb' }));
app.use(xss());
app.use(mongoSanitize());
app.use(hpp());
app.use(i18nMiddleware);

// Rutas protegidas
app.use('/apms',         validateApiKey,       rateLimiter,         require('./src/channels/apms/apmsHandler'));
app.use('/transactions', validateApiKey,       rateLimiter,         require('./src/routes/transactions'));
app.use('/tokens',       validateTokenApiKey,  rateLimiterTokens,   require('./src/tokens/tokenRoutes')); // ✅ cambiado
app.use('/analytics',    validateApiKey,       rateLimiter,         require('./src/routes/analytics'));
app.use('/merchants',    validateApiKey,       rateLimiter,         require('./src/routes/merchantRoutes'));

// Ruta de prueba
app.use('/test', require('./src/routes/testRoutes'));

// Rutas públicas
app.use('/webhooks', rateLimiterWebhooks, require('./src/routes/webhooks'));
app.use('/webhooks', require('./src/webhooks/webhookReceiver'));

// Manejo de errores
app.use(notFoundHandler);
app.use(errorHandler);

// Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Pasarela escuchando en puerto ${PORT}`);
});
