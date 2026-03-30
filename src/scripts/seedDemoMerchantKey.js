// src/scripts/seedDemoMerchantKey.js
'use strict';

/**
 * Script de un solo uso.
 * Crea una API key para demo-merchant en MongoDB.
 *
 * Uso:
 *   MONGO_URI=<tu uri> node src/scripts/seedDemoMerchantKey.js
 *
 * La key se muestra en consola UNA SOLA VEZ. Guárdala en Postman.
 */

require('dotenv').config();
const mongoose       = require('mongoose');
const { createApiKey } = require('../services/apiKeyService');

// Necesitamos registrar el modelo antes de usarlo
require('../models/MerchantApiKey');

async function seed() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('❌ MONGO_URI no definida');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log('✅ MongoDB conectado');

  const result = await createApiKey('demo-merchant', 'key inicial seed');

  console.log('\n========================================');
  console.log('✅ API key creada para demo-merchant');
  console.log('========================================');
  console.log('keyId:     ', String(result.keyId));
  console.log('keyPrefix: ', result.keyPrefix);
  console.log('apiKey:    ', result.raw);
  console.log('========================================');
  console.log('⚠️  Guarda el valor "apiKey" ahora.');
  console.log('    No se puede recuperar después.');
  console.log('========================================\n');

  await mongoose.disconnect();
  process.exit(0);
}

seed().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
