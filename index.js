// index.js
const express = require('express');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const mongoose = require('mongoose');

let morgan = null;
try { morgan = require('morgan'); }
catch { console.warn('⚠️ [WARN] morgan no está instalado. Logging HTTP desactivado.'); }

require('dotenv').config();
const app = express();

/* ===== Helpers para dependencias opcionales (no romper si no están) ===== */
function tryRequire(name) {
  try { return require(name); } catch { return null; }
}
const mongoSanitize = tryRequire('express-mongo-sanitize');
const xssClean      = tryRequire('xss-clean');
const hpp           = tryRequire('hpp');
let rateLimiterGlobal = null;
try { rateLimiterGlobal = require('./src/middleware/rateLimiterGlobal'); } catch { /* opcional */ }

/* MONETISER PATCH START: CSP estricta opcional */
let cspStrict = null;
try { cspStrict = require('./src/middleware/cspStrict'); } catch {}
const FEATURE_CSP_STRICT = process.env.FEATURE_CSP_STRICT === '1';
/* MONETISER PATCH END */

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
if (FEATURE_CSP_STRICT && cspStrict) app.use(cspStrict());

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
if (mongoSanitize) app.use(mongoSanitize());
if (xssClean)      app.use(xssClean());
if (hpp)           app.use(hpp());
if (rateLimiterGlobal) app.use(rateLimiterGlobal);
if (morgan) app.use(morgan('dev'));

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

/* ===== Rutas principales ===== */
let initializeRoutesExport;
try {
  initializeRoutesExport = require('./src/routes/initializeRoutes');
  console.log('🟢 [DEBUG] initializeRoutes export:', initializeRoutesExport);
} catch (err) {
  console.error('❌ [ERROR] require("./src/routes/initializeRoutes"):', err);
}
app.use('/initialize', ensureRouter(initializeRoutesExport, 'initializeRoutes'));

// Iframe
const iframeRouter = ensureRouter(require('./src/routes/iframe'), 'iframe');
app.use('/iframe', iframeRouter);
app.use('/iframe-process', iframeRouter);

// APMs y Tokens
app.use('/apms', ensureRouter(require('./src/channels/apms/apmsHandler'), 'apmsHandler'));
app.use('/tokens', ensureRouter(require('./src/tokens/tokenRoutes'), 'tokenRoutes'));

/* MONETISER PATCH START: nueva ruta de orquestación (no rompe nada existente) */
app.use('/orchestration', ensureRouter(require('./src/routes/orchestrationRoutes'), 'orchestrationRoutes'));
/* MONETISER PATCH END */

// Static
app.use(express.static(path.join(__dirname, 'public')));

/* ===== Error handler ===== */
app.use((err, req, res, next) => { // eslint-disable-line
  console.error('❌ [ERROR]', err);
  res.status(500).json({ error: 'Internal Server Error' });
});

/* ===== Mongo + arranque ===== */
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
  console.error('❌ [FATAL] MONGO_URI no está definido.');
  process.exit(1);
}

mongoose.connect(MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  serverSelectionTimeoutMS: 20000,
  socketTimeoutMS: 45000
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
