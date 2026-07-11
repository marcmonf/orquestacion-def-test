const express = require('express');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const mongoose = require('mongoose');
const serverPaymentRoutes = require('./src/routes/serverPaymentRoutes');
const hostedCheckoutRoutes = require('./src/routes/hostedCheckoutRoutes');
const proxyPciRoutes = require('./src/routes/proxyPciRoutes');

let morgan = null;
try { morgan = require('morgan'); }
catch { console.warn('⚠️ [WARN] morgan no está instalado. Logging HTTP desactivado.'); }

require('dotenv').config();
const app = express();

/* ===== Helpers para dependencias opcionales (no romper si no están) ===== */
function tryRequire(name) { try { return require(name); } catch { return null; } }
const mongoSanitize = tryRequire('express-mongo-sanitize');
const xssClean      = tryRequire('xss-clean');
const hpp           = tryRequire('hpp');
let rateLimiterGlobal = null;
try { rateLimiterGlobal = require('./src/middleware/rateLimiterGlobal'); } catch {}

/* ===== Middlewares globales ===== */
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (!allowedOrigins.length || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'), false);
  },
  credentials: false
}));

app.use(helmet());

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
if (mongoSanitize) app.use(mongoSanitize());
if (xssClean)      app.use(xssClean());
if (hpp)           app.use(hpp());
if (rateLimiterGlobal) app.use(rateLimiterGlobal);
if (morgan) app.use(morgan('dev'));

/* ✅ i18n correcto: usa TU middleware existente */
try {
  const i18nMiddleware = require('./src/i18n/i18nMiddleware');
  app.use(i18nMiddleware);
} catch (e) {
  console.warn('⚠️ [WARN] i18nMiddleware no cargado:', e.message);
}

/* Render/Proxies: evita warnings de X-Forwarded-For si activas rate-limits */
app.set('trust proxy', 1);

/* ===== Contexto de petición (request-id) ===== */
const logger = require('./src/utils/logger');
app.use((req, res, next) => {
  const rid = req.headers['x-request-id']?.toString().trim() || (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  req.context = {
    requestId: rid,
    ip: req.ip,
    userAgent: req.headers['user-agent']
  };
  res.setHeader('x-request-id', rid);
  logger.info('HTTP IN', { requestId: rid, component: 'http', event: `${req.method} ${req.originalUrl}` });
  res.on('finish', () => {
    logger.info('HTTP OUT', {
      requestId: rid,
      component: 'http',
      event: `${req.method} ${req.originalUrl}`,
      data: { statusCode: res.statusCode }
    });
  });
  next();
});

/* ===== Utilidad ensureRouter ===== */
const ensureRouter = (moduleExport, moduleName) => {
  const express = require('express');
  const looksLikeExpress =
    moduleExport &&
    (typeof moduleExport === 'function' || typeof moduleExport === 'object') &&
    typeof moduleExport.use === 'function' &&
    typeof moduleExport.handle === 'function';
  if (looksLikeExpress) return moduleExport;

  if (moduleExport && typeof moduleExport === 'object' && moduleExport.router &&
      typeof moduleExport.router.use === 'function' && typeof moduleExport.router.handle === 'function') {
    return moduleExport.router;
  }
  console.warn(`⚠️ [WARN] El módulo "${moduleName}" no exporta un Router válido. Se envuelve en uno vacío.`);
  const router = express.Router();
  router.use((req, res) => res.status(500).json({ error: `Ruta "${moduleName}" mal exportada` }));
  return router;
};

/* ===== Healthcheck ===== */
app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

/* ===== Idempotencia en /initialize (opt-in por header) ===== */
const idempotency = require('./src/middleware/idempotency');
app.use('/initialize', idempotency());

/* ===== Rutas principales ===== */
let initializeRoutesExport;
try {
  initializeRoutesExport = require('./src/routes/initializeRoutes');
  console.log('🟢 [DEBUG] initializeRoutes export:', initializeRoutesExport);
} catch (err) {
  console.error('❌ [ERROR] require("./src/routes/initializeRoutes"):', err);
}
app.use('/initialize', ensureRouter(initializeRoutesExport, 'initializeRoutes'));

// Iframe: mismo router para /iframe y /iframe-process
const iframeRouter = ensureRouter(require('./src/routes/iframe'), 'iframe');
app.use('/iframe', iframeRouter);
app.use('/iframe-process', iframeRouter);

// Versiones con merchantId en la URL para el iframe
app.use('/:merchantId/iframe', iframeRouter);
app.use('/:merchantId/iframe-process', iframeRouter);

// Hosted Payment Page (HPP)
app.use('/hpp', ensureRouter(require('./src/routes/hpp'), 'hpp'));

// APMs y Tokens
app.use('/apms', ensureRouter(require('./src/channels/apms/apmsHandler'), 'apmsHandler'));
app.use('/tokens', ensureRouter(require('./src/tokens/tokenRoutes'), 'tokenRoutes'));

// Orquestración + reglas
app.use('/orchestration', ensureRouter(require('./src/routes/orchestrationRoutes'), 'orchestrationRoutes'));
app.use('/rules', ensureRouter(require('./src/routes/rulesRoutes'), 'rulesRoutes'));

// Webhooks entrantes de PSPs
app.use('/webhooks', ensureRouter(require('./src/routes/webhooks'), 'webhooks'));

// Transactions
try {
  app.use('/transactions', ensureRouter(require('./src/routes/transactions'), 'transactions'));
} catch {
  console.warn('⚠️ [WARN] /transactions no montado (archivo faltante)');
}

// API Keys management (admin)
app.use('/api-keys', ensureRouter(require('./src/routes/apiKeyRoutes'), 'apiKeyRoutes'));

// Backoffice — auth pública (login/logout/setup)
app.use('/backoffice/auth', ensureRouter(require('./src/routes/backofficeAuthRoutes'), 'backofficeAuthRoutes'));

// Backoffice — endpoints protegidos por JWT de sesión
app.use('/backoffice', ensureRouter(require('./src/routes/backofficeRoutes'), 'backofficeRoutes'));

// Payment Request
app.use('/payment-requests', ensureRouter(require('./src/routes/paymentRequests'), 'paymentRequests'));

// Gestión de merchants (admin) — modelo Merchant unificado (M2)
// IMPORTANTE: debe montarse ANTES del bloque comodín '/:merchantId/...'
app.use('/merchants', ensureRouter(require('./src/routes/merchantRoutes'), 'merchantRoutes'));

// 📌 Endpoints con merchantId como segmento de URL
app.use('/:merchantId/payments/server', serverPaymentRoutes);
app.use('/:merchantId/payments/hosted', hostedCheckoutRoutes);
app.use('/:merchantId/proxy-pci', proxyPciRoutes);

// Payments (router agregador existente)
app.use('/payments', ensureRouter(require('./src/routes/payments'), 'payments'));

/* ===== Static ===== */
app.use('/admin', express.static(path.join(__dirname, 'public/admin')));
app.use(express.static(path.join(__dirname, 'public')));

/* ===== Error handler global ===== */
app.use((err, req, res, next) => { // eslint-disable-line
  console.error('❌ [ERROR] ', err);
  logger.error('UNCAUGHT', { component: 'http', requestId: req?.context?.requestId, data: { error: err?.message } });
  res.status(500).json({ error: 'Internal Server Error' });
});

/* ===== Conexión a MongoDB + arranque ===== */
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
  console.error('❌ [FATAL] MONGO_URI no está definido.');
  process.exit(1);
}

mongoose.set('bufferCommands', false);
mongoose.set('strictQuery', true);

mongoose.connect(MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  serverSelectionTimeoutMS: 7000,
  socketTimeoutMS: 20000,
  maxPoolSize: 5,
  retryWrites: true,
})
.then(() => {
  console.log('✅ MongoDB conectado');
  app.listen(PORT, () => console.log(`🚀 Servidor en puerto ${PORT}`));
})
.catch(err => {
  console.error('❌ Error conectando a MongoDB:', err);
  process.exit(1);
});

process.on('SIGINT', async () => {
  try { await mongoose.connection.close(); } finally { process.exit(0); }
});
