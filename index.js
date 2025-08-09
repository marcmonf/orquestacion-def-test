// index.js
const express = require('express');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

require('dotenv').config();

const app = express();

// Middlewares globales
app.use(cors());
app.use(helmet());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

// Utilidad para envolver exportaciones no válidas en un router vacío
const ensureRouter = (moduleExport, moduleName) => {
  const express = require('express');
  if (typeof moduleExport === 'function' || (moduleExport && typeof moduleExport === 'function' && moduleExport.name === 'router')) {
    return moduleExport;
  }
  if (moduleExport && moduleExport.stack && Array.isArray(moduleExport.stack)) {
    return moduleExport; // Ya es un router válido
  }
  console.warn(`⚠️ [WARN] El módulo "${moduleName}" no exporta un router válido. Envolviendo en router vacío...`);
  const router = express.Router();
  router.use((req, res) => {
    res.status(500).json({ error: `Ruta "${moduleName}" mal exportada` });
  });
  return router;
};

// Ruta de healthcheck
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// ==== Rutas principales ====

// Initialize
app.use(
  '/initialize',
  ensureRouter(require('./src/routes/initializeRoutes'), 'initializeRoutes')
);

// Iframe
app.use(
  '/iframe',
  ensureRouter(require('./src/routes/iframe'), 'iframe')
);

// Ejemplo de otros módulos que puedan estar fallando
app.use(
  '/apms',
  ensureRouter(require('./src/channels/apms/apmsHandler'), 'apmsHandler')
);

app.use(
  '/tokens',
  ensureRouter(require('./src/tokens/tokenRoutes'), 'tokenRoutes')
);

// Aquí irían todas las demás rutas que tenías, usando ensureRouter()
// ...

// Static files (por si tu iframe.html está en public/)
app.use(express.static(path.join(__dirname, 'public')));

// Error handler global
app.use((err, req, res, next) => {
  console.error('❌ [ERROR] ', err);
  res.status(500).json({ error: 'Internal Server Error' });
});

// Servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en puerto ${PORT}`);
});
