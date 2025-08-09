// index.js
const express = require('express');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');

// morgan opcional (no rompe si no está instalado)
let morgan = null;
try {
  morgan = require('morgan');
} catch (e) {
  console.warn('⚠️ [WARN] morgan no está instalado. El logging HTTP queda desactivado.');
}

require('dotenv').config();

const app = express();

// ===== Middlewares globales =====
app.use(cors());
app.use(helmet());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
if (morgan) app.use(morgan('dev'));

// ===== Utilidad para envolver exportaciones no válidas en un router vacío =====
const ensureRouter = (moduleExport, moduleName) => {
  const express = require('express');

  // Si es app o router de Express, tendrá .use y .handle
  const looksLikeExpress =
    moduleExport &&
    (typeof moduleExport === 'function' || typeof moduleExport === 'object') &&
    typeof moduleExport.use === 'function' &&
    typeof moduleExport.handle === 'function';

  if (looksLikeExpress) return moduleExport;

  // Si exporta { router } (patrón común)
  if (
    moduleExport &&
    typeof moduleExport === 'object' &&
    moduleExport.router &&
    typeof moduleExport.router.use === 'function' &&
    typeof moduleExport.router.handle === 'function'
  ) {
    return moduleExport.router;
  }

  console.warn(`⚠️ [WARN] El módulo "${moduleName}" no exporta un Router de Express válido. Se envuelve en uno vacío.`);
  const router = express.Router();
  router.use((req, res) => {
    res.status(500).json({ error: `Ruta "${moduleName}" mal exportada` });
  });
  return router;
};

// ===== Ruta de healthcheck =====
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// ===== Rutas principales =====

// Initialize con try/catch y log de exportación
let initializeRoutesExport;
try {
  initializeRoutesExport = require('./src/routes/initializeRoutes');
  console.log('🟢 [DEBUG] require("./src/routes/initializeRoutes") devolvió:', initializeRoutesExport);
} catch (err) {
  console.error('❌ [ERROR] No se pudo hacer require("./src/routes/initializeRoutes"):', err);
}
app.use(
  '/initialize',
  ensureRouter(initializeRoutesExport, 'initializeRoutes')
);

// Iframe (sin parámetros → iframe.html dentro del router; con parámetros → flujo pago)
const iframeRouter = ensureRouter(require('./src/routes/iframe'), 'iframe');
app.use('/iframe', iframeRouter);
app.use('/iframe-process', iframeRouter); // mismo router

// Otros módulos que puedan estar fallando: envueltos con ensureRouter
app.use(
  '/apms',
  ensureRouter(require('./src/channels/apms/apmsHandler'), 'apmsHandler')
);

app.use(
  '/tokens',
  ensureRouter(require('./src/tokens/tokenRoutes'), 'tokenRoutes')
);

// Aquí podrías añadir el resto de rutas siguiendo el mismo patrón:
// app.use('/transactions', ensureRouter(require('./src/routes/transactions'), 'transactions'));
// app.use('/analytics', ensureRouter(require('./src/routes/analytics'), 'analytics'));
// app.use('/merchants', ensureRouter(require('./src/routes/merchantRoutes'), 'merchantRoutes'));
// app.use('/recurrent-profiles', ensureRouter(require('./src/routes/recurrentprofiles'), 'recurrentprofiles'));
// app.use('/pms', ensureRouter(require('./src/routes/pmsRoutes'), 'pmsRoutes'));
// etc...

// ===== Static files (por si tu iframe.html está en public/) =====
app.use(express.static(path.join(__dirname, 'public')));

// ===== Error handler global =====
app.use((err, req, res, next) => {
  console.error('❌ [ERROR]', err);
  res.status(500).json({ error: 'Internal Server Error' });
});

// ===== Servidor =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en puerto ${PORT}`);
});
