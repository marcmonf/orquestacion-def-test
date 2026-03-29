// src/middleware/apiKeyAuth.js
'use strict';

/**
 * MONETISER: Este archivo es un alias de src/middleware/auth.js
 * 
 * El middleware canónico de autenticación por API key de merchant es auth.js.
 * Este re-export existe para no romper imports históricos que apunten a este archivo.
 * 
 * NO añadir lógica aquí. Modificar solo auth.js.
 */
module.exports = require('./auth');
```

**Por qué esto es mejor que eliminar el archivo:** hay rutas (`orchestrationRoutes.js`) que hacen `require('../middleware/auth')` con un try/catch manual. Dejando el re-export nos aseguramos de que cualquier path funcione.

---

### Paso 4 — Añadir variable de entorno en Render para `API_KEYS_MAP`

Para que `auth.js` pueda validar la key de `demo-merchant`, necesita el mapa definido. Ve a Render → Environment y añade:
```
API_KEYS_MAP={"demo-merchant":"TU_API_KEY_ACTUAL"}
```

Donde `TU_API_KEY_ACTUAL` es la misma key que tienes configurada en Postman como `x-api-key` para los tests de demo-merchant.

> ⚠️ Si ya tienes `API_KEY` definida como variable global en Render, `auth.js` la usa como fallback cuando no encuentra el merchant en el mapa. Esto significa que funciona, pero con el mapa tienes control por merchant.

---

### Pasos de despliegue en Render

1. Aplica los tres cambios de código y haz push a `main`
2. En Render → Environment, añade `API_KEYS_MAP` con el valor del paso 4
3. Render detecta el push y redespliega automáticamente
4. Verifica en los logs de Render que arranca sin errores

---

### Verificación en Postman tras el despliegue

**Test 1 — Request válida (debe dar 200 authorized):**
```
POST https://orquestacion-def-test.onrender.com/demo-merchant/payments/server
Headers:
  x-api-key: <tu key>
  x-merchant-id: demo-merchant
  Content-Type: application/json
```

**Test 2 — Request sin key (debe dar 403):**
```
POST https://orquestacion-def-test.onrender.com/demo-merchant/payments/server
Headers:
  Content-Type: application/json
  (sin x-api-key)
```
Respuesta esperada: `{ "success": false, "message": "..." }`

**Test 3 — Request con key incorrecta (debe dar 403):**
```
x-api-key: clave_inventada
```

Si los tres tests responden como se espera, el auth unificado está operativo.

---

### Resultado final del mapa de auth
```
/rules/*                     → adminAuth.js       (X-Admin-Token)
/:merchantId/payments/server → auth.js            (x-api-key + x-merchant-id)
/:merchantId/payments/hosted → auth.js            (x-api-key + x-merchant-id)
/tokens                      → validateTokenApiKey.js (TOKEN_API_KEY, opt-in)
/pms/*                       → auth.js            (ya lo usaba)
/initialize                  → auth.js            (opt-in por ENV)
/orchestration               → auth.js            (opt-in por ENV)
apiKeyAuth.js                → re-export de auth.js (alias, sin lógica propia)
