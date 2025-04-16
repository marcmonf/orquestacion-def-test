const express = require('express');
const app = express();
const apmsRouter = require('./src/channels/apms/apmsHandler');
const webhookReceiver = require('./src/webhooks/webhookReceiver');
const mongoose = require('mongoose');
require('dotenv').config();

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
app.use('/transactions', validateApiKey, require('./src/routes/transactions'));

// Webhooks sin protección (suelen ser públicos)
app.use('/webhooks', webhookReceiver);

// Inicio del servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Pasarela escuchando en puerto ${PORT}`));
