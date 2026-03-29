// src/routes/hostedCheckoutRoutes.js
'use strict';

const express = require('express');
const router  = express.Router({ mergeParams: true });

const apiKeyAuth          = require('../middleware/auth');
const rateLimiterPayments = require('../middleware/rateLimiterPayments');

const {
  createHostedCheckout,
  getHostedCheckoutStatus
} = require('../controllers/hostedCheckoutController');

// POST /:merchantId/payments/hosted
router.post('/', rateLimiterPayments, apiKeyAuth, createHostedCheckout);

// GET /:merchantId/payments/hosted/:hostedCheckoutId/status
router.get('/:hostedCheckoutId/status', rateLimiterPayments, apiKeyAuth, getHostedCheckoutStatus);

module.exports = router;
```

---

## Pasos de despliegue en Render

No hay variables de entorno nuevas obligatorias — los valores por defecto son correctos para producción. Pero si quieres ajustarlos, puedes añadir en Render:
```
RL_PAYMENTS_WINDOW_MS=60000     # ventana en ms (default: 1 min)
RL_PAYMENTS_IP_MAX=30           # max req por IP por ventana (default: 30)
RL_PAYMENTS_MERCHANT_MAX=60     # max req por merchant por ventana (default: 60)
