// index.js

// Módulos principales
const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

// Middlewares de seguridad
const helmet = require('helmet');
const cors = require('cors');
const hpp = require('hpp');
const xss = require('xss-clean');
const mongoSanitize = require('express-mongo-sanitize');

// Middlewares personalizados
const errorHandler = require('./src/middleware/errorHandler');
const notFoundHandler = require('./src/middleware/notFoundHandler');
const rateLimiter = require('./src/middleware/rateLimiter');
const rateLimiterTokens = require('./src/middleware/rateLimiterTokens');
const rateLimiterWebhooks = require('./src/middleware/rateLimiterWebhooks');
const i18nMiddleware = require('./src/i18n/i18nMiddleware');
const getMessage = require('./src/i18n/getMessage');
const validateTokenApiKey = require('./src/middleware/validateTokenApiKey');
const checkRole = require('./src/middleware/checkRole');
const idempotencyMiddleware = require('./src/middleware/idempotency');

// Rutas
const transactionsRouter = require('./src/routes/transactions');

dotenv.config();
const app = express();
app.set('trust proxy', 1);

// Middleware para validar API Key general
const validateApiKey = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  const langHeader = req.headers['accept-language'];
  const lang = langHeader?.split(',')[0]?.split('-')[0]?.trim().toLowerCase() || 'en';

  if (!apiKey || apiKey !== process.env.API_KEY) {
    return res.status(403).json({ error: getMessage(lang, 'error.invalidApiKey') });
  }

  // ⚠️ TEMPORAL: Inyectar rol desde backend para entorno de pruebas
  // Sustituir por lógica real en producción
  req.userRole = 'admin';

  next();
};

// Conexión a MongoDB
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log('MongoDB conectado'))
.catch(err => console.error('Error de conexión MongoDB:', err));

// Middlewares de seguridad global
app.use(helmet());
app.use(cors({
  origin: ['https://orquestacion-def-test.onrender.com'],
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-User-Role'],
  credentials: true
}));
app.use(express.json({ limit: '10kb' }));
app.use(xss());
app.use(mongoSanitize());
app.use(hpp());
app.use(i18nMiddleware);

// Servir contenido estático seguro (iFrame)
app.use(express.static(path.join(__dirname, 'public')));
app.get('/iframe', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'iframe.html'));
});

// ✅ Ruta pública para iFrame seguro
app.use('/iframe-process', require('./src/routes/iframe'));

// Rutas protegidas por API Key y roles
app.use('/apms', validateApiKey, checkRole(['admin']), rateLimiter, require('./src/channels/apms/apmsHandler'));

// ✅ Aplicar idempotency SOLO en POST /transactions
app.use('/transactions', (req, res, next) => {
  if (req.method === 'POST') {
    return validateApiKey(req, res, () =>
      checkRole(['admin', 'merchant'])(req, res, () =>
        rateLimiter(req, res, () =>
          idempotencyMiddleware(req, res, () =>
            transactionsRouter(req, res, next)
          )
        )
      )
    );
  } else {
    return validateApiKey(req, res, () =>
      checkRole(['admin', 'merchant'])(req, res, () =>
        rateLimiter(req, res, () =>
          transactionsRouter(req, res, next)
        )
      )
    );
  }
});

app.use('/tokens', validateTokenApiKey, checkRole(['admin']), rateLimiterTokens, require('./src/tokens/tokenRoutes'));
app.use('/analytics', validateApiKey, checkRole(['admin', 'analyst']), rateLimiter, require('./src/routes/analytics'));
app.use('/merchants', validateApiKey, checkRole(['admin']), rateLimiter, require('./src/routes/merchantRoutes'));
app.use('/recurrent-profiles', validateApiKey, checkRole(['admin', 'merchant']), rateLimiter, require('./src/routes/recurrentprofiles'));

// Ruta de prueba protegida
app.use('/test', require('./src/routes/testRoutes'));

// Endpoint de health check
app.use('/health', require('./src/routes/health'));

// Rutas públicas para webhooks
app.use('/webhooks', rateLimiterWebhooks, require('./src/routes/webhooks'));
app.use('/webhooks', require('./src/webhooks/webhookReceiver'));

// Middleware para rutas no encontradas
app.use(notFoundHandler);

// Middleware de gestión de errores centralizada
app.use(errorHandler);

// Inicio del servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Pasarela escuchando en puerto ${PORT}`);
});
