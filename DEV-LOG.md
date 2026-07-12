# DEV-LOG — Monetiser Payment Orchestration Platform

> Repositorio: `marcmonf/orquestacion-def-test` · Rama: `main`
> Stack: Node.js + Express + MongoDB Atlas · Despliegue: Render
> URL de producción: `https://orquestacion-def-test.onrender.com`
> Última actualización: julio 2026

---

## Índice

1. [Visión general del producto](#1-visión-general-del-producto)
2. [Arquitectura del sistema](#2-arquitectura-del-sistema)
3. [Fases completadas](#3-fases-completadas)
4. [Problemas encontrados y cómo se resolvieron](#4-problemas-encontrados-y-cómo-se-resolvieron)
5. [Gaps actuales y deuda técnica](#5-gaps-actuales-y-deuda-técnica)
6. [Hoja de ruta — próximos hitos](#6-hoja-de-ruta--próximos-hitos)
7. [Elementos de seguridad](#7-elementos-de-seguridad)
8. [Variables de entorno](#8-variables-de-entorno)
9. [Referencia rápida de endpoints](#9-referencia-rápida-de-endpoints)
10. [Observabilidad y logs](#10-observabilidad-y-logs)

---

## 1. Visión general del producto

Monetiser es una **Payment Orchestration Platform (POP) SaaS B2B** orientada al mercado europeo. Actúa como intermediario inteligente entre merchants (tiendas online, plataformas) y PSPs (Payment Service Providers / adquirentes).

**Propuesta de valor:**
- Un único punto de integración para el merchant, independientemente del adquirente.
- Routing inteligente de transacciones mediante reglas configurables (por BIN, importe, país, scheme, tipo de tarjeta).
- Fallback automático entre adquirentes si el principal falla.
- iFrame propio que oculta al merchant toda la complejidad de PCI DSS.
- Webhooks salientes normalizados: el merchant recibe siempre el mismo contrato de mensaje.

**Decisión arquitectónica clave:**
El iFrame de Monetiser es el único punto de contacto entre el usuario final y la página de pago. El routing al adquirente ocurre de forma invisible. El merchant solo embebe una URL de iFrame. Los campos de tarjeta (PAN, CVV, fecha) son campos de ProxyFields de Paylands embebidos dentro del iFrame de Monetiser — Monetiser nunca toca el PAN. El cardholder introduce los datos una sola vez.

---

## 2. Arquitectura del sistema

### Flujo completo de un pago (estado actual — julio 2026)

```
Merchant backend
    │
    └─ POST /:merchantId/payments/hosted
           │  Body: { order, feedbacks }  ← SIN datos de tarjeta
           │  Auth: x-api-key + x-merchant-id
           │  Devuelve: redirectUrl → /hpp/:hostedCheckoutId
           │
           ↓
    GET /hpp/:hostedCheckoutId
           │  Construye URL firmada → redirige a /:merchantId/iframe?paymentId=...
           │
           ↓
    GET /:merchantId/iframe?paymentId=...
           │  Sirve iframe.html con branding del merchant (logo, colores)
           │  Incluye campos ProxyFields de Paylands embebidos en el DOM de Monetiser
           │
           ↓
    Usuario introduce PAN, CVV, fecha en los campos ProxyFields
           │  PAN NUNCA toca servidores de Monetiser (SAQ A PCI scope)
           │  ProxyFields tokeniza el PAN en el sistema Proxy PCI de Paylands
           │  Devuelve: card UUID (ej: "0EA9C363-1535-4E08-AD45-5F4F43...")
           │
           ↓
    POST /:merchantId/proxy-pci/session   → Obtiene token de sesión PCI
    POST /:merchantId/proxy-pci/charge    → chargeWithToken con card UUID
           │
           │  Llama a POST /payment en Paylands con source_uuid = card UUID
           │  Paylands devuelve: threeDsUrl (URL de autenticación 3DS tokenizada)
           │  El frontend carga threeDsUrl en el mismo iframe (window.location.href)
           │  El banco autentica al cardholder (3DS) — SIN formulario de tarjeta de Paylands
           │
           ↓
    POST /webhooks/paynopain
           │  Paylands notifica el resultado
           │  Monetiser verifica validation_hash: SHA-256({ order, client } + PAYNOPAIN_SIGNATURE)
           │  Actualiza Transaction en MongoDB: status → "authorized"
           │  Dispara webhook saliente al merchant (callbackUrl)
           │
           ↓
    webhookDispatcher.enqueue()
           │  HTTP POST al callbackUrl del merchant
           │  Firma HMAC saliente · retry con backoff exponencial
```

### Componentes principales

| Archivo / Módulo | Función |
|---|---|
| `index.js` | Entry point, conexión MongoDB, montaje de routers |
| `src/middleware/auth.js` | Re-export de hmacAuth — middleware canónico de autenticación |
| `src/middleware/hmacAuth.js` | Auth HMAC Worldline (GCS v1HMAC) + fallback x-api-key simple (API_KEY_SIMPLE_FALLBACK=true) |
| `src/middleware/rateLimiterPayments.js` | Doble límite IP + merchant en rutas de pago |
| `src/services/paymentService.js` | Orquesta Rule Engine + connectors + fallback |
| `src/core/ruleEngineV2.js` | Evalúa política de routing por contexto de transacción |
| `src/services/connectorRegistry.js` | Registro de conectores activos (dummyCard, payNoPain) |
| `src/connectors/paynopain/payNoPainConnector.js` | Conector real Paylands — chargeWithToken usa POST /payment + source_uuid |
| `src/connectors/dummy/dummyCardConnector.js` | Conector simulado para tests |
| `src/routes/webhooks.js` | Webhook entrante de Paylands → verifica SHA-256 → actualiza Transaction |
| `src/services/webhookDispatcher.js` | Webhook saliente al merchant con HMAC + retry |
| `src/services/pciProxyService.js` | Sesión PCI + getTokenizationResults (obtiene card UUID de Paylands) |
| `src/routes/proxyPciRoutes.js` | Endpoints /proxy-pci/session y /proxy-pci/charge |
| `src/routes/iframe.js` | Sirve iframe.html con runtime inyectado. frame-ancestors: * para permitir embebido |
| `src/routes/hpp.js` | Recibe hostedCheckoutId → redirect 302 a /:merchantId/iframe firmado |
| `public/iframe.html` | iFrame del checkout con campos ProxyFields de Paylands embebidos |
| `public/test-checkout.html` | Página de test para merchant: pega redirectUrl y carga en iframe |
| `src/models/Transaction.js` | Modelo central de estado de cada pago |
| `src/models/MerchantApiKey.js` | API keys en MongoDB (hash SHA-256 del secret) |
| `src/models/WebhookEvent.js` | Auditoría de webhooks entrantes |
| `src/models/WebhookLog.js` | Log de intentos de entrega saliente |
| `src/models/TraceLog.js` | Trazas de sistema en MongoDB |
| `src/utils/logger.js` | Logger estructurado → MongoDB + consola |
| `src/utils/cryptoUtils.js` | AES-256-GCM, HMAC helpers, maskPan |
| `src/services/apiKeyService.js` | Generación, validación y revocación de API keys |
| `src/routes/apiKeyRoutes.js` | CRUD de API keys |

---

## 3. Fases completadas

### Fase 1 — Infraestructura base ✅
- Node.js + Express + MongoDB Atlas + Render
- Middleware globales: CORS, Helmet, express-mongo-sanitize, xss-clean, hpp
- Rate limiting global, logging estructurado, audit logger, i18n

### Fase 2 — Flujo S2S ✅
- `POST /:merchantId/payments/server` con auth + rate limit
- Conector dummyCard para tests
- Modelo Transaction en MongoDB

### Fase 3 — Rule Engine V2 ✅
- Motor de reglas configurable por merchant
- Evaluación por: amount, currency, BIN, issuerCountry, scheme, cardType, method
- CRUD de políticas, dry-run, historial de cambios
- Fallback configurable entre conectores
- Métricas de conectores en memoria

### Fase 4 — Conector real PayNoPain (Paylands) ✅
- Autenticación HTTP Basic Auth
- Endpoint sandbox: `https://api.paylands.com/v1/sandbox/payment`
- Orden real verificada en portal Paylands

### Fase 5 — Auth por API key en MongoDB ✅
- Modelo MerchantApiKey con hash SHA-256 del secret
- HMAC Worldline como método principal: `Authorization: GCS v1HMAC:<keyId>:<signature>`
- Fallback x-api-key simple activable con `API_KEY_SIMPLE_FALLBACK=true`
- CRUD completo de API keys por merchant
- Endpoint de creación: `POST /api-keys/:merchantId` con `X-Admin-Token`

### Fase 6 — Flujo Hosted Checkout con ProxyFields (M1) ✅ — COMPLETADO JULIO 2026

**Este es el hito más importante completado.** El flujo end-to-end funciona:

1. Merchant llama `POST /demo-merchant/payments/hosted` sin datos de tarjeta → recibe `redirectUrl`
2. Merchant embebe la `redirectUrl` en un `<iframe>` en su web (o usa `test-checkout.html` para testing)
3. El iFrame de Monetiser carga con branding del merchant (logo Inditex, colores)
4. Los campos de tarjeta son ProxyFields de Paylands embebidos — Monetiser nunca ve el PAN
5. El cardholder introduce datos UNA SOLA VEZ — sin segundo formulario de Paylands
6. Monetiser obtiene el card UUID de ProxyFields via `getTokenizationResults`
7. Monetiser llama `POST /payment` en Paylands con `source_uuid = card UUID`
8. Paylands devuelve `threeDsUrl` — URL de autenticación 3DS tokenizada
9. El iFrame navega a la `threeDsUrl` via `window.location.href` — el banco autentica
10. Paylands dispara webhook a Monetiser con `validation_hash` SHA-256
11. Monetiser verifica la firma, actualiza Transaction a `status: authorized`
12. Monetiser dispara webhook saliente al merchant

**Tarjetas de test habilitadas en sandbox (ServiceUUID: B8A7367B-73D9-4110-8B81-ECD875601BEF):**
- `4018810000100036` · exp: `12/34` · CVV: `123` ✅ VERIFICADA
- `4018810001010010` · exp: `12/34` · CVV: `123`
- `4018810000150015` · exp: `12/34` · CVV: `123`
- `4018810000190011` · exp: `12/34` · CVV: `123`

**NOTA:** La tarjeta `4507670001000009` NO funciona con el flujo tokenizado (solo con hosted checkout directo de Paylands).

**Credenciales de demo-merchant:**
- `rawKeyId`: `mk_7065b5507c6efae4d1067f2768919154`
- `rawSecret`: `ms_03e84aaa3db4875d22ffd87fc397b3a6803739555f987ceaddb9a7c52d3c2a52`
- Auth en Postman: headers `x-api-key: mk_7065b5507c6efae4d1067f2768919154` + `x-merchant-id: demo-merchant`
- Requiere `API_KEY_SIMPLE_FALLBACK=true` en Render ENV

**Bugs resueltos en esta fase:**
- `frame-ancestors: none` bloqueaba el embebido → cambiado a `frame-ancestors: *`
- `X-Frame-Options: SAMEORIGIN` de Helmet bloqueaba → `res.removeHeader('X-Frame-Options')` en iframe.js
- El endpoint `/charge` de Paylands devuelve 403 (requiere perfil PCI especial) → solución: usar `POST /payment` con `source_uuid` + `threeDsUrl`
- El `validation_hash` del webhook de Paylands se calcula como `SHA-256(JSON.stringify({order, client}) + PAYNOPAIN_SIGNATURE)` — sin incluir `extra_data` si no está presente
- El status se guardaba como `declined` antes de verificar si había 3DS → reordenado para guardar `pending_3ds` correctamente
- `orderUuid` del webhook estaba en `body.order.uuid`, no en `body.order_uuid`
- `STATUS_MAP` no incluía `SUCCESS` → añadido

---

## 4. Problemas encontrados y cómo se resolvieron

| Problema | Causa | Solución |
|---|---|---|
| `hostedCheckoutId` no se guardaba en Transaction | Campo no declarado en schema Mongoose → silently discarded | Añadir campo al schema |
| Firma HMAC siempre inválida en Postman | `crypto.subtle` es async y no bloquea el envío de la request | Usar CryptoJS síncrono o x-api-key simple |
| `Customer not found` al llamar `/charge` de Paylands | El endpoint `/charge` requiere perfil PCI especial | Usar `POST /payment` con `source_uuid` + URL tokenizada |
| Segundo iframe de Paylands aparecía tras pagar | El código creaba un `<iframe>` con la `checkoutUrl` | Cambiar a `window.location.href` para navegar en el mismo iframe |
| `validation_hash` del webhook siempre incorrecto | Se incluía `extra_data: null` en el JSON hasheado | Excluir `extra_data` si no está presente en el body |
| test-checkout.html no cargaba la URL | `X-Frame-Options: SAMEORIGIN` de Helmet | `res.removeHeader('X-Frame-Options')` en las rutas del iframe |
| Template literal corrupto en blob de GitHub | Interpolación de variables en heredoc | Escribir siempre a `/tmp/` y usar `base64 -w 0` para el blob |

---

## 5. Gaps actuales y deuda técnica

| Gap | Prioridad | Descripción |
|---|---|---|
| ~~Modelo Merchant en MongoDB~~ | ✅ M2 COMPLETADO | Modelo `Merchant` unificado con campos operativos (plan, status, webhookUrl, signingSecret, serviceUuid, templateUuid, branding). Rutas `/merchants` montadas y protegidas por X-Admin-Token. Dispatcher firma por-merchant. Detalle completo en sección 6 (M2). |
| Panel de administración `/admin` | Alta — M3 | No hay UI para operar sin Postman ni Atlas |
| OpenAPI completa | Media — M4 | La spec actual no refleja proxy-pci ni el flujo real de hosted checkout |
| test-checkout.html no carga con iframe | Baja | El botón "Cargar" no funciona — workaround: abrir la URL directamente en el navegador |
| Logs de debug en producción | Baja | Hay varios `logger.info` con `fullBody` y `tokenKeys` que deben eliminarse antes de producción |
| WEBHOOK_SECRET | Media | Ya NO es bloqueante: desde M2 Fase C el dispatcher firma con el `signingSecret` del merchant y solo usa `WEBHOOK_SECRET` como fallback global. Conviene configurarlo igualmente para merchants sin secreto propio. |
| Suite de tests no verde en algunos entornos | Media | `npx jest` → 119/128 pasan. Los 9 fallos están en `tests/integration/webhooks.test.js` y son PREEXISTENTES (no los introdujo M2): la suite necesita MongoDB en memoria / config de entorno que no siempre está. Verificado clonando el código original. `supertest` es devDependency y debe estar instalada para correr las suites de integración. |

---

## 6. Hoja de ruta — próximos hitos

### M2 — Modelo Merchant ✅ COMPLETADO (julio 2026)

**Contexto importante:** al empezar M2 se descubrió que el modelo ya existía a medias.
Había DOS modelos solapados y un archivo de rutas huérfano (herencia de versiones
antiguas del proyecto, hechas con GPT-3):
- `Merchant.js` existía pero con esquema incompleto (branding plano, email/password legacy).
- `MerchantHierarchy.js` modela la organización corporativa (globalGroup → group → branch
  → region → tienda) y era el que usaban las rutas — pero esas rutas NO estaban montadas.

**Decisión:** unificar en `Merchant` como modelo operativo y dejar `MerchantHierarchy`
en STANDBY (funcionalidad legítima a futuro para clientes enterprise). Ver la nota de
reactivación en la cabecera de `src/models/MerchantHierarchy.js`.

**Lo implementado (por fases, todas verificadas en Render):**

- **Fase A** — `src/models/Merchant.js` unificado. Campos operativos: `name`, `country`,
  `plan` (free/starter/growth/enterprise), `status` (active/suspended/pending),
  `webhookUrl`, `signingSecret`, `serviceUuid`, `templateUuid`, `branding` anidado,
  `updatedAt`. Se conservaron TODOS los campos legacy (branding plano `logoUrl`/`brandColor`,
  secretos `signingSecret`/`hmacSecret`/`secret` que lee `hpp.js`, email/passwordHash).
  Puente a jerarquía: campo `hierarchyId` (ObjectId, ref MerchantHierarchy, default null).
- **Fase B** — `src/routes/merchantRoutes.js` reescrito sobre el modelo `Merchant` y
  MONTADO en `index.js` como `/merchants` (antes estaba huérfano). Protegido por
  `adminAuth` (X-Admin-Token). Endpoints: `POST /merchants`, `GET /merchants` (paginado
  + búsqueda), `GET /merchants/:merchantId`, `PATCH /merchants/:merchantId`. Los secretos
  nunca se devuelven en las respuestas.
- **Fase C** — `src/services/webhookDispatcher.js` resuelve el secreto de firma POR
  MERCHANT: usa `Merchant.signingSecret` (o hmacSecret/secret) y hace fallback a la
  variable global `WEBHOOK_SECRET`. Si el merchant tiene secreto propio, el webhook se
  envía aunque no exista el global. Solo marca `no_secret_config` si no hay ninguno.
- **Fase D** — `src/models/MerchantHierarchy.js` marcado EN STANDBY con nota de
  reactivación en cabecera (el esquema no se tocó). DEV-LOG actualizado a la realidad
  del repo.
- **Fase E** — Vulnerabilidad `uuid` cerrada: subido de `9.0.0` a `11.1.1`
  (GHSA-w5hq-g745-h8pq). `npm audit` → `found 0 vulnerabilities`. Sin regresión: todos
  los usos del código son `v4()` con import nombrado, que no cambió entre v9 y v11.
  Verificado corriendo la suite completa (mismos 119/128 que antes del cambio).

**Alineación con Paylands:** `serviceUuid` → campo `service` de POST /payment;
`templateUuid` → `template_uuid` (plantilla de la carta de pago). Ambos opcionales con
fallback a las variables globales de entorno (hoy `demo-merchant` usa las globales).

**Endpoint de creación (ejemplo verificado):**
```
POST /merchants   (header: X-Admin-Token)
{ "merchantId": "test-m2", "name": "...", "country": "ES",
  "plan": "starter", "status": "active", "webhookUrl": "https://..." }
→ 201, sin signingSecret en la respuesta
```

### M3 — Panel de administración (EN PROGRESO — julio 2026)
**Objetivo:** UI en `/admin` para operar sin Postman ni Atlas.

**Contexto descubierto:** ya existía un panel a medias (herencia de versiones antiguas).
Conviven DOS paneles en `public/admin/`:
- `dashboard.html` + `dashboard.js` → el panel BUENO. Login por email+contraseña contra
  `/backoffice/auth/login` (modelo BackofficeUser, con roles). Tiene analíticas,
  transacciones con refund/cancel, y gestión de usuarios. ES EL QUE SE USA.
- `index.html` + `app.js` → editor de reglas de routing antiguo (usa ADMIN_TOKEN).
  Preservado, accesible en `/admin/index.html`.

**Hecho en esta sesión (Fase A + fixes de datos):**
- **Fase A** — `/admin` ahora sirve `dashboard.html` como página principal (ruta explícita
  en index.js antes del estático). El editor viejo sigue en `/admin/index.html`.
- **Fix importes** — el dashboard mostraba los importes ×100 (interpretaba céntimos como
  euros). Corregido: `fmt()` en dashboard.js divide /100 al mostrar; el modal de refund
  trabaja en euros de cara al usuario y convierte a céntimos al enviar. IMPORTANTE: los
  importes se almacenan SIEMPRE en céntimos (Paylands-style, amount:100 = 1,00 €).
- **Fix processorReference** — `iframe.js` guardaba el orderUuid de Paylands en `authCode`
  en vez de en `processorReference` (el campo por el que el webhook busca la tx). Corregido.
- **Refund PayNoPain** — implementado `refund()` en el conector (POST /payment/refund de
  Paylands). Antes daba 502 porque no existía la función. VERIFICADO funcionando end-to-end.
- **Endpoint /diag** — herramienta de diagnóstico solo-lectura (protegida por X-Admin-Token)
  en `src/routes/diagRoutes.js`: `GET /diag/transactions` muestra estado real de las tx en
  Mongo sin entrar a Atlas. Útil para depurar. Considerar quitarlo o dejarlo como interno.

**Pendiente de M3:**
- Pestaña de gestión de MERCHANTS en el dashboard (crear/listar/editar) — conecta con las
  rutas /merchants de M2. Decisión tomada: exponer merchants bajo /backoffice (mismo login
  del dashboard) reutilizando el modelo Merchant; mantener /merchants con X-Admin-Token (M2)
  intacto. NO empezado.
- Pestaña de API keys (crear/revocar).
- Absorber el editor de reglas viejo como pestaña.

**Aprendizaje clave de esta sesión — TARJETAS DE TEST:**
Las tarjetas de test REALES de Paylands sandbox son las `4018810000100036` / `4018810001010010`
/ `4018810000150015` / `4018810000190011` (exp 12/34, CVV 123). La tarjeta `4507670001000009`
es INVENTADA y NO funciona (en 3DS deja la tx colgada en pending_3ds porque el challenge nunca
se resuelve → Paylands nunca manda webhook). NO usarla nunca.

**Nota sobre pagos colgados en pending_3ds:** las tx que quedan en pending_3ds con
webhookReceived:false son pruebas con tarjeta mala cuyo 3DS no se completó. El webhook de
cierre (webhooks.js) está bien montado y verificado; solo cierra tx cuando Paylands notifica
un pago realmente completado. Sin challenge 3DS, el cierre es síncrono (iframe.js).

### M4 — OpenAPI completa
**Objetivo:** Documentar el contrato real de la API.
- Endpoints de proxy-pci
- Flujo completo de hosted checkout
- Contrato de webhooks salientes (lo que recibe el merchant)
- Endpoints de gestión de merchants y API keys

### M5 — PCI SAQ A formal
- Documentar que Monetiser cumple SAQ A: el PAN nunca toca los servidores de Monetiser
- ProxyFields de Paylands como evidencia técnica

### M6 — Onboarding de merchants
- Flujo completo: registro → creación de cuenta → generación de API keys → configuración de webhook

### M7 — Billing
- Modelo BillingRecord en MongoDB
- Tracking de transacciones por merchant y período
- Integración con Stripe Billing o Paddle

---

## 7. Elementos de seguridad

### Implementados

| Elemento | Dónde | Descripción |
|---|---|---|
| Auth por API key | `src/middleware/hmacAuth.js` | SHA-256 del secret comparado con `secretHash` en MongoDB. Timing-safe comparison. |
| Fallback auth simple | `src/middleware/hmacAuth.js` | `x-api-key` simple activable con `API_KEY_SIMPLE_FALLBACK=true` en ENV |
| Rate limiting IP | `src/middleware/rateLimiterGlobal.js` | 200 req/15min por IP |
| Rate limiting IP + merchant | `src/middleware/rateLimiterPayments.js` | Doble límite en rutas de pago |
| Sanitización inputs | `index.js` | express-mongo-sanitize, xss-clean, hpp |
| Helmet | `index.js` | Headers HTTP de seguridad |
| CSP en iFrame | `src/routes/iframe.js` | frame-ancestors: * (permite embebido por merchants) |
| Firma HMAC webhooks salientes | `src/services/webhookDispatcher.js` | Header `Monetiser-Signature: t=<ts>, v1=<hex>` |
| Verificación SHA-256 webhook Paylands | `src/routes/webhooks.js` | SHA-256({order, client} + PAYNOPAIN_SIGNATURE). Timing-safe. |
| PAN nunca en servidores | `public/iframe.html` + ProxyFields | Monetiser solo ve el card UUID |
| Máscara PAN en logs | `src/utils/cryptoUtils.js` | maskPan() devuelve BIN******last4 |
| AES-256-GCM | `src/utils/cryptoUtils.js` | IV aleatorio por operación y AAD |
| Revocación API keys | `src/services/apiKeyService.js` | Marca active: false + revokedAt |

### Pendientes

| Elemento | Prioridad |
|---|---|
| WEBHOOK_SECRET configurado en Render | Alta |
| Eliminar logs de debug (fullBody, tokenKeys) antes de producción | Alta |
| 2FA para panel admin | Media |
| Rotación de PAYNOPAIN_SIGNATURE | Media |

---

## 8. Variables de entorno

### Configuradas en Render (necesarias para funcionar)

| Variable | Descripción |
|---|---|
| `MONGO_URI` | URI de conexión a MongoDB Atlas |
| `PORT` | Puerto (Render lo asigna automáticamente) |
| `PAYNOPAIN_API_KEY` | API key de la cuenta Paylands |
| `PAYNOPAIN_SIGNATURE` | Signature literal del servicio Paylands (se usa para calcular validation_hash del webhook) |
| `PAYNOPAIN_SERVICE_UUID` | UUID del servicio configurado en Paylands (B8A7367B-73D9-4110-8B81-ECD875601BEF en sandbox) |
| `PAYNOPAIN_ENV` | `sandbox` o `production` |
| `ADMIN_TOKEN` | Token para endpoints de administración (X-Admin-Token) |
| `API_KEY_SIMPLE_FALLBACK` | `true` — activa auth simple x-api-key para Postman/testing |
| `SERVER_URL` | `https://orquestacion-def-test.onrender.com` — para construir URLs de webhook hacia Paylands |

### Opcionales / Feature flags

| Variable | Descripción |
|---|---|
| `WEBHOOK_SECRET` | Secret para firmar webhooks salientes. Verificar que está configurado. |
| `ENCRYPTION_KEY` | 32 bytes en hex para AES-256-GCM |
| `FEATURE_IFRAME_GUARD` | `1` para activar validación HMAC en carga del iFrame |
| `WEBHOOK_MAX_RETRIES` | Intentos máximos del dispatcher (default: 6) |
| `LOG_LEVEL` | Nivel mínimo de logs: error, warning, info, debug, trace |
| `ALLOW_PAN_DECRYPT` | `true` solo en desarrollo |
| `ALLOWED_ORIGINS` | CORS origins permitidos (separados por coma) |

---

## 9. Referencia rápida de endpoints

### Merchant (pagos)

```
POST /:merchantId/payments/hosted                        → Crear Hosted Checkout (sin datos de tarjeta)
GET  /:merchantId/payments/hosted/:hostedCheckoutId/status → Estado del Hosted Checkout
POST /:merchantId/payments/server                        → Pago S2S (con datos de tarjeta en body)
POST /:merchantId/proxy-pci/session                      → Sesión PCI para ProxyFields
POST /:merchantId/proxy-pci/charge                       → Cobro con card UUID de ProxyFields
GET  /:merchantId/iframe                                 → Cargar iFrame de checkout
GET  /hpp/:hostedCheckoutId                              → Redirect a iFrame firmado
```

Auth: `x-api-key: <rawKeyId>` + `x-merchant-id: <merchantId>` (modo simple, `API_KEY_SIMPLE_FALLBACK=true`)

### Administración

```
POST   /api-keys/:merchantId           → Crear API key (devuelve rawKeyId + rawSecret)
GET    /api-keys/:merchantId           → Listar API keys activas
DELETE /api-keys/:merchantId/:keyId    → Revocar API key

GET    /rules/:merchantId              → Política de routing actual
PUT    /rules/:merchantId              → Crear/actualizar política
POST   /rules/try                      → Dry-run del rule engine
GET    /rules/:merchantId/audit        → Historial de cambios
```

Auth: `X-Admin-Token: <ADMIN_TOKEN>`

### Observabilidad

```
GET /transactions                      → Listar transacciones
GET /transactions/:paymentId           → Detalle de transacción
GET /transactions/analytics/summary    → Métricas agregadas
GET /webhooks                          → Histórico de WebhookEvents
GET /webhooks?paymentId=<id>           → Filtrar por pago
```

### Internos / PSPs

```
POST /webhooks/paynopain               → Recibe notificación de Paylands (sin auth)
```

### Testing

```
GET /test-checkout.html                → Página de test para merchant (pega redirectUrl y carga en iframe)
```

---

## 10. Observabilidad y logs

### MongoDB Atlas — colecciones

| Colección | Qué contiene |
|---|---|
| `tracelogs` | Todo lo que pasa por `logger.*` |
| `transactions` | Estado de cada pago. status: pending → pending_3ds → authorized / declined |
| `webhookevents` | Notificaciones entrantes de Paylands con rawPayload |
| `webhooklogs` | Intentos de entrega saliente al merchant |
| `merchantapikeys` | Keys de merchants (secretHash, nunca el secret en plano) |
| `routingpolicies` | Historial de políticas de routing por merchant |

### Secuencia de logs de un pago exitoso

```
POST /demo-merchant/payments/hosted 200
GET  /hpp/:id 302
GET  /demo-merchant/iframe 200
POST /demo-merchant/proxy-pci/session 200  → PCI_PROXY_TOKENIZE_ISSUED
POST /demo-merchant/proxy-pci/charge 200   → PCI_PROXY_GET_RESULTS_OK
                                           → PAYNOPAIN_CHARGE_TOKEN_ORDER_RESULT status:200
                                           → PAYNOPAIN_CHARGE_TOKEN_3DS_URL
                                           → PROXY_PCI_CHARGE_RESULT status:pending_3ds
POST /webhooks/paynopain 200               → WEBHOOK_PAYNOPAIN_RECEIVED
                                           → WEBHOOK_PAYNOPAIN_TX_UPDATED status:authorized
                                           → WEBHOOK_PAYNOPAIN_OUTBOUND_ENQUEUED
```

---

*Última revisión: 12 julio 2026 — descubierto sistema legacy de capture/refund/cancel sin documentar (paymentsController.js + Operation). Refund reconectado a Paylands real (POST /payment/refund) con fix de seguridad (ownership de merchant) y fix de lógica (refund sin capture previa). Capture reconectado a Paylands (POST /payment/capture, INFERIDO por analogía, sin verificar en sandbox). Cancel sigue siendo simulación pura. Pendiente: verificar refund y capture en Postman contra Render cuando Marcos tenga acceso al Mac. Sesión anterior (11 julio tarde): /admin sirve el dashboard bueno, importes corregidos a euros, processorReference arreglado en iframe.js, endpoint /diag añadido. M1 y M2 completados. Tarjetas test buenas: 4018810...*

---

## 11. Ciclo de vida del pago — capture / refund / cancel

**Descubrimiento importante (julio 2026):** ya existia un sistema completo de
capture/refund/cancel sin documentar en este DEV-LOG — herencia de una version
anterior del proyecto. Vive en `src/routes/payments.js` +
`src/controllers/paymentsController.js` + modelo `Operation` (bookkeeping de
importes capturados/reembolsados), montado en Express como `POST /payments/:paymentId/{capture,refund,cancel}`
(sin merchantId en la URL — se resuelve por header `x-merchant-id` via hmacAuth).
Tenia: idempotencia (`Idempotency-Key` obligatorio), validacion Joi, audit log,
replay de operaciones duplicadas. Pero **NO llamaba a Paylands** — solo movia
estados en Mongo. Simulacion pura.

**Bugs encontrados y corregidos en esta sesión:**
- `ensureTx()` no comprobaba que la transaccion perteneciera al merchant
  autenticado — cualquier merchant con API key valida podia operar sobre pagos
  ajenos si adivinaba el `paymentId`. Corregido: 404 si `tx.merchantId !== req.merchantId`.
- La logica de refund exigia una operacion de `capture` previa para calcular
  el importe reembolsable. Como Paylands no tiene paso de captura separado en
  el flujo actual (AUTHORIZATION ya mueve el dinero), cualquier refund fallaba
  con "exceeds captured amount". Corregido: si no hay `capture` registrada,
  se usa el importe autorizado como base reembolsable.

### Estado actual por flujo

| Flujo | Endpoint Monetiser | Endpoint Paylands | Estado |
|---|---|---|---|
| Autorizacion | POST /:merchantId/payments/hosted | POST /payment (operative: AUTHORIZATION) | ✅ funciona |
| Refund (total/parcial) | POST /payments/:paymentId/refund | POST /payment/refund (order_uuid + amount opcional) | ✅ CONECTADO A PAYLANDS REAL — pendiente de test en sandbox (Marcos sin acceso a Postman/Render en esta sesión) |
| Captura | POST /payments/:paymentId/capture | POST /payment/capture (order_uuid + amount opcional) | ⚠️ CONECTADO pero endpoint Paylands es INFERENCIA por analogia con refund — SIN VERIFICAR contra sandbox real |
| Cancelacion (void) | POST /payments/:paymentId/cancel | — | ❌ SIGUE SIENDO SIMULACION — no llama a Paylands todavia |

### Ciclo de vida de una transaccion

```
pending
  └─ pending_3ds
       └─ authorized       ← ya funciona
            ├─ captured / partially_captured   ← conector conectado (sin verificar)
            ├─ cancelled                       ← pendiente (solo simulacion)
            └─ refunded / partially_refunded   ← conector conectado (sin verificar)
  └─ declined
  └─ error
```

### Pruebas pendientes (bloqueadas — Marcos sin acceso a Postman/Render en esta sesión)

1. **Refund real**: `POST https://orquestacion-def-test.onrender.com/payments/{paymentId}/refund`
   con `x-api-key`, `x-merchant-id: demo-merchant`, `Idempotency-Key`, body
   `{amountOfMoney:{amount,currencyCode:"EUR"}}`. Usar un `paymentId` con
   status `authorized` (ver `/diag/transactions`). Esperar 200 (`refunded`/
   `partially_refunded`) o 502 (`processor_declined`).
2. **Capture real**: mismo patron en `/payments/{paymentId}/capture`. Prioridad
   alta: confirmar si `POST /payment/capture` es el endpoint correcto de
   Paylands — si Paylands responde 404 o error de ruta, revisar documentacion
   real de Paylands para el endpoint de captura.
3. Verificar en ambos casos que el webhook saliente al merchant notifica el
   estado correcto.
4. **Cancel/void**: implementar llamada real a Paylands (próximo hito, aún no
   iniciado).

Esto forma parte de M2/M3 y debe verificarse en sandbox antes de produccion.
