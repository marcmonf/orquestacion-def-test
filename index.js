const express = require('express');
const app = express();
const apmsRouter = require('./src/channels/apms/apmsHandler');
const webhookReceiver = require('./src/webhooks/webhookReceiver');
const mongoose = require('mongoose');
require('dotenv').config();

mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log("MongoDB conectado"))
  .catch(err => console.error("Error de conexión MongoDB:", err));

app.use(express.json());
app.use('/apms', apmsRouter);
app.use('/webhooks', webhookReceiver);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Pasarela escuchando en puerto ${PORT}`));