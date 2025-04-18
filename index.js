const express = require('express');
const app = express();
const mongoose = require('mongoose');
require('dotenv').config();

// Importar rutas
const apmsRouter = require('./src/channels/apms/apmsHandler');
const webhookReceiver = require('./src/webhooks/webhookReceiver');
const transactionsRouter = require('./src/routes/transactions');
const webhooksRouter = require('./src/routes/webhooks');
const tokenRoutes = require('./src/tokens/tokenRoutes');
const analyticsRouter = require('./src/routes/analytics');
const merchantRoutes = require('./src/routes/merchantRoutes'); // <-- NUEVA RUTA

// Conexión a MongoDB
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log("MongoDB conectado"))
  .catch(err => console.error("Error de conexión MongoDB:", err));

app.use(express.json());

// Middleware para validar la API Key
const validateApiKey = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== process.env.API_KEY) {
    return res.status(403).json({ error: 'API Key inválida o ausente' });
  }
  next();
};

// Rutas protegidas
app.use('/apms', validateApiKey, apmsRouter);
app.use('/transactions', validateApiKey, transactionsRouter);
app.use('/tokens', validateApiKey, tokenRoutes);
app.use('/analytics', validateApiKey, analyticsRouter);
app.use('/merchants', validateApiKey, merchantRoutes); // <-- NUEVA RUTA PROTEGIDA

// Rutas públicas
app.use('/webhooks', webhookReceiver);
app.use('/webhooks', webhooksRouter);

// Inicio del servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Pasarela escuchando en puerto ${PORT}`));
