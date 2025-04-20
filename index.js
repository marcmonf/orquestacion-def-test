const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const errorHandler = require('./src/middleware/errorHandler');
const rateLimiter = require('./src/middleware/rateLimiter');
const rateLimiterTokens = require('./src/middleware/rateLimiterTokens');
const rateLimiterWebhooks = require('./src/middleware/rateLimiterWebhooks'); // NUEVO

dotenv.config();
const app = express();

// Conexión a MongoDB
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log('MongoDB conectado'))
.catch(err => console.error('Error de conexión MongoDB:', err));

// Middleware global
app.use(express.json());

// Middleware de API Key
const validateApiKey = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== process.env.API_KEY) {
    return res.status(403).json({ error: 'API Key inválida o ausente' });
  }
  next();
};

// Rutas protegidas
app.use('/apms', validateApiKey, rateLimiter, require('./src/channels/apms/apmsHandler'));
app.use('/transactions', validateApiKey, rateLimiter, require('./src/routes/transactions'));
app.use('/tokens', validateApiKey, rateLimiterTokens, require('./src/tokens/tokenRoutes')); // LIMITER específico
app.use('/analytics', validateApiKey, rateLimiter, require('./src/routes/analytics'));
app.use('/merchants', validateApiKey, rateLimiter, require('./src/routes/merchantRoutes'));

// Ruta temporal de prueba
app.use('/test', require('./src/routes/testRoutes'));

// Rutas públicas (con limiter específico para webhooks)
app.use('/webhooks', rateLimiterWebhooks, require('./src/routes/webhooks'));
app.use('/webhooks', require('./src/webhooks/webhookReceiver')); // sin rate limit si solo escucha

// Middleware de errores
app.use(errorHandler);

// Lanzar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Pasarela escuchando en puerto ${PORT}`);
});
