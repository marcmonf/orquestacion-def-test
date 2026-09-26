// dotenv PRIMERO: varios módulos leen process.env al cargarse (conector de
// Paylands, rate limiters, secretos). Antes se cargaba después de requerir las
// rutas de pago y, en local, esos módulos no veían el .env.
require('dotenv').config();

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const cors = require('cors');
const helmet = require('helmet');
const mongoose = require('mongoose');
const serverPaymentRoutes = require('./src/routes/serverPaymentRoutes');
const hostedCheckoutRoutes = require('./src/routes/hostedCheckoutRoutes');
const proxyPciRoutes = require('./src/routes/proxyPciRoutes');
const webhookDispatcher = require('./src/services/webhookDispatcher');
const { isDevOrTest } = require('./src/utils/runtimeSecrets');

let morgan = null;
try { morgan = require('morgan'); }
catch { console.warn('⚠️ [WARN] morgan no está instalado. Logging HTTP desactivado.'); }

const app = express();

/* Render/Proxies: req.ip = IP real del cliente (primer salto). Todo lo que
 * necesite la IP (rate limits, auditoría) usa req.ip — nunca X-Forwarded-For a
 * mano, que lo controla el cliente. */
app.set('trust proxy', 1);
app.disable('x-powered-by');

/* ===== Helpers para dependencias opcionales (no romper si no están) ===== */
function tryRequire(name) { try { return require(name); } catch { return null; } }
const mongoSanitize = tryRequire('express-mongo-sanitize');
const xssClean      = tryRequire('xss-clean');
const hpp           = tryRequire('hpp');
let rateLimiterGlobal = null;
try { rateLimiterGlobal = require('./src/middleware/rateLimiterGlobal'); } catch {}

/* ===== Contexto de petición (request-id) — lo primero de todo ===== */
const logger = require('./src/utils/logger');
app.use((req, res, next) => {
  // Se acepta el x-request-id del cliente solo si es un identificador sano
  // (evita inyección de líneas en logs); si no, se genera uno.
  const incoming = String(req.headers['x-request-id'] || '').trim();
  const rid = /^[A-Za-z0-9._-]{1,64}$/.test(incoming) ? incoming : crypto.randomUUID();
  req.context = {
    requestId: rid,
    ip: req.ip,
    userAgent: req.headers['user-agent']
  };
  res.setHeader('x-request-id', rid);
  // Traza HTTP a nivel debug: con LOG_LEVEL=info (por defecto) no se escribe en
  // Mongo. Antes eran DOS escrituras en `tracelogs` por cada petición (HTTP IN
  // y HTTP OUT), sin caducidad — la colección crecía sin límite. morgan ya
  // imprime cada petición en la consola de Render.
  res.on('finish', () => {
    logger.debug('HTTP OUT', {
      requestId: rid,
      component: 'http',
      event: `${req.method} ${req.originalUrl}`,
      data: { statusCode: res.statusCode }
    });
  });
  next();
});

/* ===== Middlewares globales ===== */
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (!allowedOrigins.length || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(Object.assign(new Error('Not allowed by CORS'), { status: 403 }), false);
  },
  credentials: false
}));

app.use(helmet());

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

/* ===== Healthcheck ===== */
app.get('/health', (req, res) => res.status(200).json({
  status: 'ok',
  db: mongoose.connection.readyState === 1 ? 'up' : 'down',
}));

/* ===== Webhooks entrantes de PSPs — ANTES de sanitizadores y rate limit global =====
 * xss-clean y mongo-sanitize REESCRIBEN el body; cualquier cambio invalida el
 * validation_hash de Paylands y el pago se quedaba colgado. Y Paylands notifica
 * desde pocas IPs: el límite global por IP acabaría devolviéndole 429.
 * La ruta verifica la firma antes de usar nada del body. */
app.use('/webhooks', require('./src/routes/webhooks'));

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

/* ===== Utilidad ensureRouter ===== */
const ensureRouter = (moduleExport, moduleName) => {
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

/* ===== Rutas principales ===== */
// /initialize retirado (17 jul 2026): stack legacy pre-Hosted-Checkout.
// Nada del front ni de los flujos actuales lo llamaba. El flujo real de
// creación de pagos es POST /:merchantId/payments/hosted (y S2S).

// Iframe de pago (solo GET). /iframe-process retirado el 26 sep 2026: era un
// endpoint público que aceptaba PAN y aprobaba con el conector simulado. Ver
// src/routes/iframe.js y DEV-LOG §4.
const iframeRouter = ensureRouter(require('./src/routes/iframe'), 'iframe');
app.use('/iframe', iframeRouter);
app.use('/:merchantId/iframe', iframeRouter);

// Hosted Payment Page (HPP)
app.use('/hpp', ensureRouter(require('./src/routes/hpp'), 'hpp'));

// /apms retirado (16 jul 2026): era un stack de pago paralelo de una version
// antigua — publico sin auth, sin validacion efectiva y aceptaba PAN en crudo.
// Procesaba contra conectores simulados. Ver DEV-LOG seccion 4. Los APMs reales
// (M8) se construiran sobre connectorRegistry, no sobre aquello.
// /tokens retirado (17 jul 2026): aceptaba PAN + CVV y guardaba el PAN cifrado
// en MongoDB (bóveda propia = scope SAQ D). La tokenización real la hace
// ProxyFields de Paylands; Monetiser nunca debe almacenar PAN.

// Orquestación: diagnóstico interno del motor de reglas (X-Admin-Token).
app.use('/orchestration', ensureRouter(require('./src/routes/orchestrationRoutes'), 'orchestrationRoutes'));

// Retirados el 26 sep 2026 (decisión de Marcos): /rules, /merchants, /api-keys y
// /diag con X-Admin-Token, y el editor de reglas viejo (/admin/index.html). Todo
// eso existe en /admin con sesión y usuario (pestañas Reglas, Merchants, API
// Keys y detalle de transacción), que deja rastro de quién hizo qué. Menos
// puertas abiertas con un token compartido.

// Transactions
try {
  app.use('/transactions', ensureRouter(require('./src/routes/transactions'), 'transactions'));
} catch {
  console.warn('⚠️ [WARN] /transactions no montado (archivo faltante)');
}

// Backoffice — auth pública (login/logout/setup)
app.use('/backoffice/auth', ensureRouter(require('./src/routes/backofficeAuthRoutes'), 'backofficeAuthRoutes'));

// Backoffice — endpoints protegidos por JWT de sesión
app.use('/backoffice', ensureRouter(require('./src/routes/backofficeRoutes'), 'backofficeRoutes'));

// Portal del merchant (M6) — plano de usuarios de merchant, AISLADO por sesión.
// Prefijo fijo: debe montarse ANTES del bloque comodín '/:merchantId/...' de abajo.
// Auth pública del portal (login / cambio de password / logout):
app.use('/portal/auth', ensureRouter(require('./src/routes/portalAuthRoutes'), 'portalAuthRoutes'));
// Jerarquía de tiendas (M6 Fase 2) — montada ANTES de '/portal' por ser más específica:
app.use('/portal/hierarchy', ensureRouter(require('./src/routes/portalHierarchyRoutes'), 'portalHierarchyRoutes'));
// Endpoints del portal protegidos por la sesión de portal (JWT aud 'portal'):
app.use('/portal', ensureRouter(require('./src/routes/portalRoutes'), 'portalRoutes'));

// /payment-requests retirado (17 jul 2026): stack legacy que desembocaba en el
// CRUD antiguo de transacciones. Sin uso desde el front ni desde merchants.

// 📌 Endpoints con merchantId como segmento de URL
app.use('/:merchantId/payments/server', serverPaymentRoutes);
app.use('/:merchantId/payments/hosted', hostedCheckoutRoutes);
app.use('/:merchantId/proxy-pci', proxyPciRoutes);

// Payments (router agregador existente)
app.use('/payments', ensureRouter(require('./src/routes/payments'), 'payments'));

/* ===== Static ===== */
// /admin (exacto) sirve el dashboard de backoffice como página principal.
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/admin/dashboard.html'));
});
app.use('/admin', express.static(path.join(__dirname, 'public/admin')));

// Portal VISUAL del merchant (M6 Fase 3) — SPA separada en /portal-app.
// Sirve public/portal/ (login, cambio de password, dashboard tenant-scoped).
// Habla solo con la API /portal/* (que va autenticada); estos estáticos van en
// /portal-app para NO chocar con ese namespace autenticado.
app.get('/portal-app', (req, res) => res.sendFile(path.join(__dirname, 'public/portal/index.html')));
app.use('/portal-app', express.static(path.join(__dirname, 'public/portal')));

/* ===== Documentación pública de la API (M4, pendiente desde el 16 jul 2026) =====
 * Swagger UI sobre openapi.yaml. Sin dependencias npm nuevas: el bundle viene de
 * CDN (ver comentario en public/docs.html).
 * Se puede apagar con DOCS_ENABLED=false en Render.
 */
if (String(process.env.DOCS_ENABLED || 'true').toLowerCase() !== 'false') {
  app.get('/openapi.yaml', (req, res) => {
    res.type('application/yaml');
    res.sendFile(path.join(__dirname, 'openapi.yaml'));
  });

  app.get('/docs', (req, res) => {
    // CSP acotada A ESTA RUTA: helmet() aplica su default-src 'self' a toda la
    // app y bloquearía el bundle del CDN. res.setHeader reemplaza la cabecera
    // que helmet ya puso, sin tocar el resto de rutas.
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; " +
      "script-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'; " +
      "style-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'; " +
      "img-src 'self' data: https://cdn.jsdelivr.net; " +
      "font-src 'self' data: https://cdn.jsdelivr.net; " +
      "connect-src 'self'; frame-ancestors 'none'"
    );
    res.sendFile(path.join(__dirname, 'public/docs.html'));
  });
}

app.use(express.static(path.join(__dirname, 'public')));

/* ===== Error handler global =====
 * Respeta el código de los errores "esperables" (JSON mal formado → 400, body
 * demasiado grande → 413, origen CORS no permitido → 403). Antes todo salía como
 * 500 y el integrador no sabía qué había hecho mal. Nunca devuelve detalles
 * internos. */
app.use((err, req, res, next) => { // eslint-disable-line
  const status = Number(err && (err.status || err.statusCode));
  const code = Number.isInteger(status) && status >= 400 && status < 500 ? status : 500;
  if (code === 500) {
    console.error('❌ [ERROR] ', err);
    logger.error('UNCAUGHT', { component: 'http', requestId: req?.context?.requestId, data: { error: err?.message } });
  }
  if (res.headersSent) return;
  const error = code === 400 ? 'bad_request'
    : code === 403 ? 'forbidden'
    : code === 413 ? 'payload_too_large'
    : code === 500 ? 'internal_server_error'
    : 'request_error';
  res.status(code).json({ success: false, error });
});

/* ===== Comprobación de configuración al arrancar =====
 * No tumba el proceso (los pagos deben seguir funcionando), pero deja claro en
 * el log de Render qué falta. Los planos afectados responden 503 hasta que se
 * configure (fail-closed). */
function configWarnings() {
  const w = [];
  if (!process.env.ADMIN_TOKEN) w.push('ADMIN_TOKEN no definido → /orchestration/decide, GET /webhooks y la recuperación de superadmin responden 503');
  else if (process.env.ADMIN_TOKEN.length < 32) w.push('ADMIN_TOKEN demasiado corto (< 32 caracteres)');
  if (!isDevOrTest()) {
    if (!process.env.BACKOFFICE_JWT_SECRET) w.push('BACKOFFICE_JWT_SECRET no definido → /admin (backoffice) responde 503');
    if (!process.env.PORTAL_JWT_SECRET) w.push('PORTAL_JWT_SECRET no definido → portal del merchant responde 503');
  }
  if (process.env.BACKOFFICE_JWT_SECRET && process.env.BACKOFFICE_JWT_SECRET === process.env.PORTAL_JWT_SECRET) {
    w.push('BACKOFFICE_JWT_SECRET y PORTAL_JWT_SECRET son IGUALES: deben ser distintos');
  }
  if (!process.env.PAYNOPAIN_SIGNATURE) w.push('PAYNOPAIN_SIGNATURE no definido → los webhooks de Paylands responden 500');
  if (!process.env.HPP_SIGNING_SECRET) w.push('HPP_SIGNING_SECRET no definido → secreto aleatorio por proceso (definirlo si hay >1 instancia)');
  for (const msg of w) console.warn(`⚠️ [CONFIG] ${msg}`);
}

/* ===== Conexión a MongoDB + arranque ===== */
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
  console.error('❌ [FATAL] MONGO_URI no está definido.');
  process.exit(1);
}

configWarnings();

mongoose.set('bufferCommands', false);
mongoose.set('strictQuery', true);

let server = null;

mongoose.connect(MONGO_URI, {
  serverSelectionTimeoutMS: 7000,
  socketTimeoutMS: 20000,
  maxPoolSize: parseInt(process.env.MONGO_MAX_POOL || '20', 10),
  retryWrites: true,
})
.then(() => {
  console.log('✅ MongoDB conectado');
  server = app.listen(PORT, () => console.log(`🚀 Servidor en puerto ${PORT}`));
  // Reintentos persistentes de webhooks salientes (ver webhookDispatcher.js).
  webhookDispatcher.startWorker();
})
.catch(err => {
  console.error('❌ Error conectando a MongoDB:', err);
  process.exit(1);
});

/* ===== Robustez del proceso ===== */
// Una promesa rechazada sin capturar (p. ej. un handler async sin try/catch)
// ya no TUMBA el proceso entero — antes bastaba un fallo de Mongo en una ruta
// para reiniciar el servidor y cortar todos los pagos en curso.
process.on('unhandledRejection', (reason) => {
  console.error('❌ [unhandledRejection]', reason && reason.message ? reason.message : reason);
  try { logger.error('UNHANDLED_REJECTION', { component: 'process', data: { error: String(reason && reason.message || reason) } }); } catch {}
});

// Parada ordenada (Render envía SIGTERM en cada despliegue): deja de aceptar
// conexiones, termina las peticiones en curso y cierra Mongo.
async function shutdown(signal) {
  console.log(`⏹️  ${signal} recibido: parada ordenada`);
  webhookDispatcher.stopWorker();
  const force = setTimeout(() => process.exit(0), 10000);
  if (force.unref) force.unref();
  try {
    if (server) await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.close();
  } finally {
    process.exit(0);
  }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
