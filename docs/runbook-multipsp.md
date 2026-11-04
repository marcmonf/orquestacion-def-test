# Runbook de pruebas — framework multi-PSP (4 nov 2026)

> Para Marcos. Solo **Postman web** y **navegador**. Cada prueba dice la URL, las
> cabeceras y el cuerpo EXACTOS y lo que tiene que salir. Si algo no sale igual,
> apunta el número de prueba y la respuesta completa.
>
> **Lo primero que hay que descartar si algo falla: que no se haya desplegado.**
> Un commit no está en producción hasta que pulsas Manual Deploy en Render.

Valores que se usan abajo:

- `HOST` = `https://orquestacion-def-test.onrender.com`
- `SECRET` = el secreto de la API key de pruebas de `demo-merchant` (`ms_...`), el que
  usas en la colección Postman (variable `secret`).
- `BO_TOKEN` = el `token` que devuelve la prueba R4 (login de /admin por API).
- Tarjeta de prueba: `4018810000100036` · `12/34` · `123`.

---

## R0. Preparar y desplegar (Render)

1. Render → servicio → **Environment** → **Add Environment Variable**:
   - Key: `CREDENTIALS_ENCRYPTION_KEY`
   - Value: 64 caracteres hexadecimales aleatorios. Para generarlos, en un terminal
     de tu ordenador:
     ```bash
     node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
     ```
   - Guárdala también en tu gestor de contraseñas. **No la cambies nunca después**
     (lo cifrado con ella dejaría de abrirse).
2. **No** añadas ningún `FEATURE_*` nuevo. Tienen que seguir sin existir:
   `FEATURE_LIVEMODE`, `FEATURE_SAVED_CARDS`, `FEATURE_PAYLANDS_BIZUM`,
   `FEATURE_PAYLANDS_APPLE_PAY`, `FEATURE_PAYLANDS_GOOGLE_PAY`, `BACKOFFICE_2FA_REQUIRED`.
3. **Manual Deploy → Deploy latest commit** (cuando la rama esté fusionada en `main`).
4. **Esperado** en el log de Render al arrancar: `✅ MongoDB conectado` y `🚀 Servidor en
   puerto …`, **ningún** `⚠️ [WARN] … no montado` y **ningún** `⚠️ [CONFIG]` nuevo.

---

## R1. Regresión: el pago con Paylands sigue EXACTAMENTE igual (lo más importante)

Repite la prueba que hiciste el 4 nov con la colección **Monetiser — API v1**:

1. Petición **1. Crear sesión de pago** → **201**. Copia la `url` de la consola.
2. Abre `HOST/test-checkout.html` en el navegador, pega la `url` y pulsa **Cargar**.
   Paga con la tarjeta de prueba y completa el 3DS.
   **Esperado:** la misma pantalla de siempre (sin botones de método de pago, sin
   casilla de guardar tarjeta). Tras el 3DS: "Pago completado" y, debajo, el aviso
   con `"result": "succeeded"`.
3. Petición **3. Consultar el pago** → **200** con `"status": "authorized"` y, nuevo,
   `"livemode": false` y `"paymentMethod": "card"`.
4. Petición **5. Devolver (parcial)** ANTES de capturar → **409** `capture_required`.
5. Petición **4. Capturar** → **200** `"status": "captured"`.
6. Petición **5. Devolver (parcial)** (amount 1000) → **200** `"status": "partially_refunded"`.
7. Otra sesión (petición 1 de nuevo) → pagar → petición **6. Anular** → `"status": "cancelled"`.

Si todo coincide, el cambio no ha tocado el camino verificado con Paylands.

---

## R2. Métodos de pago (Postman, petición 7)

- `GET HOST/v1/payment-methods`
- Cabecera: `Authorization: Bearer SECRET`

**Esperado:** 200. En `data`, `card` con `"available": true`. `bizum`, `apple_pay` y
`google_pay` con `"available": false` y `reason` "pendiente de verificar con PayNoPain…".

---

## R3. Sesión con país (routing) — Postman, petición 8

- `POST HOST/v1/checkout-sessions`
- Cabeceras: `Authorization: Bearer SECRET`, `Content-Type: application/json`
- Cuerpo:
  ```json
  {
    "amount": 1500,
    "currency": "EUR",
    "reference": "PEDIDO-MULTIPSP-1",
    "country": "ES",
    "paymentMethods": ["card"],
    "returnUrl": "https://orquestacion-def-test.onrender.com/gracias.html"
  }
  ```

**Esperado:** 201 con `"livemode": false` y `"paymentMethods": ["card"]`. Paga la `url`
como en R1.2 → mismo resultado que R1. Guarda el `id` para R5.

---

## R4. Entrar en /admin por API (para las pruebas de backoffice)

- `POST HOST/backoffice/auth/login`
- Cabecera: `Content-Type: application/json`
- Cuerpo: `{ "email": "<tu email de superadmin>", "password": "<tu contraseña>" }`

**Esperado:** 200 con `token` (cópialo: es `BO_TOKEN`) y, nuevo, `user.twoFactor`:
`{ "enabled": false, "required": false }`.

En todas las pruebas R5–R9 añade la cabecera `Authorization: Bearer BO_TOKEN`.

---

## R5. La transacción guarda la decisión de routing

- `GET HOST/backoffice/transactions/<id de R3>`

**Esperado:** en `transaction.routing`: `"connector": "payNoPain"`,
`"fieldsProvider": "paylands_proxyfields"`, `"reason": "default"`,
`"context": { "amount": 1500, "currency": "EUR", "country": "ES", "paymentMethod": "card" }`,
y `transaction.connectorAccountId: "platform"`.

---

## R6. Conectores y salud

- `GET HOST/backoffice/connectors`

**Esperado:** 200 con un conector `payNoPain` ("Paylands (PayNoPain)"),
`capabilities.paymentMethods: ["card"]`, `capabilities.currencies: ["EUR"]`,
`checkoutAvailable: true` y `health.status: "closed"`. **No** debe aparecer `dummyCard`.

---

## R7. Simular el routing

- `POST HOST/backoffice/routing/demo-merchant/simulate`
- Cabecera adicional: `Content-Type: application/json`
- Cuerpo A: `{ "amount": 1000, "currency": "EUR", "country": "ES" }`
  **Esperado:** `decision.connector: "payNoPain"`, `decision.reason: "default"` (o
  `"rule"` si demo-merchant tiene una regla en /admin → Reglas).
- Cuerpo B: `{ "amount": 1000, "currency": "USD" }`
  **Esperado:** `decision.connector: null`, `decision.reason: "no_connector_available"`, y
  en `candidates` el motivo `divisa USD no soportada`. (Es correcto: hoy ningún
  adquirente procesa USD.)

---

## R8. Paylands usa la cuenta de plataforma (no se guardan credenciales por merchant)

- `PUT HOST/backoffice/merchants/demo-merchant/connector-accounts/paylands/credentials`
- Cabecera adicional: `Content-Type: application/json`
- Cuerpo: `{ "mode": "test", "credentials": { "apiKey": "x", "signature": "y", "serviceUuid": "z" } }`

**Esperado:** **409** `platform_account_only` con el mensaje "usa hoy la cuenta de
PLATAFORMA…". (Es a propósito: no se guarda nada.)

---

## R9. Checklist de producción

- `GET HOST/backoffice/production-readiness`

**Esperado (sandbox):** `"readyForProduction": false` y una lista `items`. Es normal que
salgan sin `ok` `PAYNOPAIN_ENV`, `PAYNOPAIN_PCI_CLIENT_URL`, `API_KEY_SIMPLE_FALLBACK`
y `BACKOFFICE_2FA_REQUIRED`: son las que se cambian el día de pasar a real
(`docs/produccion.md`). Comprueba que **no** aparece ningún valor secreto en la respuesta.

---

## R10. 2FA del superadmin (navegador)

1. Abre `HOST/admin` y entra como siempre.
2. Arriba a la derecha, botón **2FA** → "Estado: desactivada." → **Activar 2FA**.
3. En la app de autenticación del móvil (Google Authenticator, Microsoft
   Authenticator…): "Añadir cuenta" → "Introducir clave" → pega la clave que enseña
   /admin (tipo: basada en tiempo).
4. Escribe el código de 6 cifras de la app → **Confirmar código**.
   **Esperado:** "2FA activada… Estado: ACTIVADA."
5. **Salir** y vuelve a entrar con email y contraseña.
   **Esperado:** aparece el campo "Código de la app de autenticación (2FA)" y el aviso
   "Escribe el código de tu app de autenticación". Escribe un código malo → "Código
   incorrecto o ya usado". Escribe el bueno → entras.
6. **Si pierdes el móvil:** en Postman
   `POST HOST/backoffice/auth/reset-2fa` con cabeceras `X-Admin-Token: <ADMIN_TOKEN de
   Render>` y `Content-Type: application/json`, cuerpo `{ "email": "<tu email>" }` →
   200 `two_factor_reset_ok`; vuelves a entrar solo con contraseña.

Cuando TODOS los superadmin tengan la 2FA activada: Render → Environment →
`BACKOFFICE_2FA_REQUIRED=true` → Manual Deploy (es una decisión tuya, apuntada en el
DEV-LOG).

---

## R11. Claves nuevas con modo, y lo apagado sigue apagado

1. /admin → Merchants → demo-merchant → **API Keys** → crear una key.
   **Esperado:** el secreto empieza por `ms_test_`. Funciona en la colección Postman
   igual que la antigua (prueba la petición 7 con ella). La antigua `ms_...` sigue
   funcionando también.
2. Postman: `POST HOST/backoffice/merchants/demo-merchant/api-keys` con
   `Authorization: Bearer BO_TOKEN`, `Content-Type: application/json` y cuerpo
   `{ "label": "live", "livemode": true }` → **409** `livemode_not_enabled`.
3. Postman, petición **9. Tarjeta guardada** → **404** `saved_cards_not_enabled`.

---

## Qué NO se puede probar todavía (y por qué)

- Un segundo adquirente real: no hay credenciales de ningún otro PSP. El framework
  está probado con un PSP de prueba que solo existe en los tests.
- Bizum / Apple Pay / Google Pay, tarjeta guardada y cobros sin el cliente delante:
  apagados hasta que PayNoPain confirme cómo se integran (ver DEV-LOG, decisiones
  pendientes).
- Modo live: apagado; Paylands real llegará con el paso a producción.
