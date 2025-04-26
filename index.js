// index.js
const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const helmet = require('helmet');
const cors = require('cors'); // ✅ añadido
const hpp = require('hpp'); // ✅ añadido
const xss = require('xss-clean');
const mongoSanitize = require('express-mongo-sanitize');

const errorHandler = require('./src/middleware/errorHandler');
const notFoundHandler = require('./src/middleware/notFoundHandler');
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

// Middlewares de seguridad
app.use(helmet());

// Configuración estricta de CORS
app.use(cors({
  origin: ['https://mi-frontend.com'], // 🔥 cambiar esto por el dominio real que queramos permitir
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
  credentials: true
}));

// Limitamos el tamaño de los JSON entrantes a 10 KB
app.use(express.json({ limit: '10kb' }));

// Protección contra XSS
app.use(xss());

// Protección contra NoSQL Injection
app.use(mongoSanitize());

// Protección contra HTTP Parameter Pollution
app.use(hpp());

// Middleware de internacionalización
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
app.use('/webhooks', require('./src/webhooks/webhookReceiver'));

// Middleware para rutas no encontradas (404)
app.use(notFoundHandler);

// Middleware global de errores (500)
app.use(errorHandler);

// Lanzar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Pasarela escuchando en puerto ${PORT}`);
});
