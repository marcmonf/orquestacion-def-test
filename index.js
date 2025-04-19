const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const errorHandler = require('./src/middleware/errorHandler');

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

// Middleware para validar API Key
const validateApiKey = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== process.env.API_KEY) {
    return res.status(403).json({ error: 'API Key inválida o ausente' });
  }
  next();
};

// Rutas protegidas
app.use('/apms', validateApiKey, require('./src/channels/apms/apmsHandler'));
app.use('/transactions', validateApiKey, require('./src/routes/transactions'));
app.use('/tokens', validateApiKey, require('./src/tokens/tokenRoutes'));
app.use('/analytics', validateApiKey, require('./src/routes/analytics'));
app.use('/merchants', validateApiKey, require('./src/routes/merchantRoutes'));

// Rutas públicas (webhooks)
app.use('/webhooks', require('./src/webhooks/webhookReceiver'));
app.use('/webhooks', require('./src/routes/webhooks'));

// Middleware global de manejo de errores (al final)
app.use(errorHandler);

// Inicio del servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Pasarela escuchando en puerto ${PORT}`);
});
