# DEV-LOG — Monetiser Payment Orchestration Platform

> Repositorio: `marcmonf/orquestacion-def-test` · Rama: `main`
> Stack: Node.js + Express + MongoDB Atlas · Despliegue: Render
> URL de producción: `https://orquestacion-def-test.onrender.com`
> Última actualización: 16 julio 2026

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
| `openapi.yaml` (raíz) | **Especificación OpenAPI 3.1 v1.0.0 — contrato real de la API.** Única spec del proyecto (la antigua `openapi/monetiser.yaml` se eliminó en M4). |

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
| ~~Capture/cancel endpoints incorrectos~~ | ✅ RESUELTO Y VERIFICADO — sesión julio 2026 | Verificado con la doc oficial de Paylands (docs.paylands.com/en/reference): capture real es `POST /payment/confirmation` (no `/payment/capture`) y cancel real es `POST /payment/cancellation` (no `/payment/cancel`). **Hallazgo clave**: ambos endpoints SOLO operan sobre órdenes creadas con `operative: "DEFERRED"` — con `AUTHORIZATION` (lo que usábamos) el dinero se mueve al instante y no hay nada que confirmar/cancelar. Cambiado `operative` a `DEFERRED` en `createOrder`/`createOrder3DS`/`chargeWithToken`. **Segundo hallazgo**: una orden DEFERRED autorizada devuelve `PENDING_CONFIRMATION` (no `SUCCESS`) en el webhook — añadido al `STATUS_MAP` → `authorized`. **VERIFICADO end-to-end** (16 jul): tx nueva DEFERRED → webhook `PENDING_CONFIRMATION` → `authorized` en local → `POST /payments/{id}/capture` → `200 captured` con importe correcto. **Cancel también VERIFICADO** (16 jul): tx nueva DEFERRED autorizada sin capturar → `POST /payments/{id}/cancel` → `200 canceled`. Los tres flujos (refund total/parcial, capture, cancel) confirmados funcionando contra Paylands real. Nota operativa: durante la depuración, varios "fallos" se debieron a que las pruebas se hacían antes de que Render terminara el deploy — SIEMPRE confirmar que el deploy está Live antes de probar. |
| **S2S no cumple el objetivo "Monetiser nunca toca el PAN"** | **CRÍTICA — antes de M5 (PCI SAQ A)** | `POST /:merchantId/payments/server` acepta `cardPaymentMethodSpecificInput.card.cardNumber` en crudo en el body — a diferencia de Hosted Checkout (ProxyFields), aquí el PAN sí transita por la API de Monetiser. Además, **`payNoPainConnector.js` no tiene función `authorize()`** — solo `createOrder`/`createOrder3DS` (estilo Hosted, con redirect) y `chargeWithToken`. Como la política por defecto de cualquier merchant sin reglas custom es `defaultConnector: 'dummyCard'`, el S2S "funciona" hoy solo contra el conector de mentira; si una regla llegase a enrutar S2S hacia `payNoPain` reventaría con `connector.authorize is not a function`. **Corrección (16 jul 2026):** este párrafo afirmaba que "el PAN no se loguea en ningún punto del código". Era **falso**: se comprobaron `Transaction`, `auditLogger`, `PaymentAttempt` y `payNoPainConnector.js` (esos sí estaban limpios), pero NO se revisaron `proxyPciRoutes.js` ni `pciProxyService.js`, que sí lo logueaban. Corregido — ver la fila "Logs de debug en producción". Hoy sí es cierto: el PAN no llega a ningún logger. Aun así, aceptar el PAN en el body de la API ya pone a Monetiser en un scope PCI distinto (no SAQ A) para ese flujo concreto, y es incompatible con el objetivo declarado del proyecto. **DECISIÓN TOMADA (16 jul 2026, Marcos): OPCIÓN A — S2S solo aceptará tokens ya generados vía ProxyFields. Nunca PAN en crudo. Monetiser se mantiene en scope SAQ A.** Motivo: SAQ D (auditoría QSA externa, escaneos ASV trimestrales, pentest anual) no es asumible hoy; y el scope solo se abre en un sentido — en cuanto el PAN pasa por producción una vez, SAQ D aplica y no se vuelve atrás. Si en el futuro un merchant grande exige S2S con PAN y hay presupuesto para SAQ D, se añade entonces. **Implicaciones pendientes de implementar (NO hecho aún):** (1) rechazar `card.cardNumber` en el endpoint S2S y aceptar solo token/cardUuid; (2) escribir `authorize()` en `payNoPainConnector.js` reaprovechando `chargeWithToken` (hoy no existe — S2S solo funciona contra `dummyCard`). Alternativa contemplada y no descartada: retirar el endpoint S2S hasta que un merchant lo pida (nadie lo usa hoy). **Mientras tanto: NO usar S2S con tarjetas reales ni de test** — usar Hosted Checkout para generar transacciones de prueba contra PayNoPain real. En OpenAPI (M4) S2S se documenta como EXPERIMENTAL, nunca como estable. |
| ~~Modelo Merchant en MongoDB~~ | ✅ M2 COMPLETADO | Modelo `Merchant` unificado con campos operativos (plan, status, webhookUrl, signingSecret, serviceUuid, templateUuid, branding). Rutas `/merchants` montadas y protegidas por X-Admin-Token. Dispatcher firma por-merchant. Detalle completo en sección 6 (M2). |
| ~~Panel de administración `/admin`~~ | ✅ M3 COMPLETADO | Dashboard con analíticas, transacciones (refund/cancel/widgets expandibles), usuarios, merchants, API keys y motor de reglas. Ver sección 6 (M3). |
| ~~Capture/cancel Paylands sin verificar~~ | ✅ RESUELTO — 16 jul 2026 | Fila obsoleta, se mantenía por error contradiciendo la fila de arriba. Capture y cancel están VERIFICADOS end-to-end contra Paylands real (ver fila 1 y sección 11). |
| Flags FEATURE_RULE_* sin confirmar en Render | Media — **acción de Marcos** | ✅ DOCUMENTADOS (16 jul 2026) en sección 8 → "Flags de la pestaña Reglas": qué activa cada uno, qué botón depende de cuál, y por qué `FEATURE_RULE_AUDIT` es el más importante (sin él los cambios de reglas se guardan sin histórico). Pendiente: ponerlos a `1` en Render → Environment. No se ha tocado la config de Render. |
| Editor de reglas viejo (`/admin/index.html` + `app.js`) | Baja | Redundante desde que existe la pestaña Reglas del dashboard nuevo (mismo backend). Sigue ahí sin usarse ni eliminarse — decisión de Marcos si lo retira. |
| ~~OpenAPI completa~~ | ✅ M4 COMPLETADO — 16 jul 2026 | `openapi.yaml` en la raíz (3.1, v1.0.0): 23 rutas, 27 operaciones, 21 schemas, 4 webhooks salientes, 0 refs rotas. Una sola spec: la antigua `openapi/monetiser.yaml` eliminada y su contenido portado (nada la referenciaba). Ver sección 6 (M4). |
| **Webhooks salientes: TRES emisores distintos, firmas incompatibles** | **ALTA — rompe integraciones** | Descubierto al escribir el OpenAPI (M4). Existen **tres** implementaciones independientes de "enviar webhook al merchant", escritas en momentos distintos y ninguna consciente de las otras (misma acumulación histórica que los dos modelos de Merchant y los dos paneles de admin). **No depende del entorno**: los nombres de cabecera son literales escritos a fuego, sin ningún `if` sobre `NODE_ENV`/`PAYNOPAIN_ENV`. <br><br>**(1) `src/services/webhookDispatcher.js`** — evento `payment.updated`. Usado por `routes/webhooks.js` y `transactionController.js`. Header `Monetiser-Signature: t=<ts>, v1=<hex>` (CON espacio tras la coma). Secreto: `signingSecret` del merchant → fallback `WEBHOOK_SECRET`. Reintentos con backoff. Registro en `webhooklogs`. <br>**(2) `sendWebhookIfAny()` en `src/controllers/paymentsController.js`** — eventos `payment.captured`/`refunded`/`canceled`. Header **`x-monetiser-signature: t=<ts>,v1=<hex>`** (nombre DISTINTO, SIN espacio) + `x-monetiser-timestamp`. Secreto: **solo `WEBHOOK_SECRET` global**. **Sin reintentos. Sin registro** (fallo = un `warn`). <br>**(3) `src/core/webhookService.js`** — vía `core/transactionManager.js` ← `channels/apms/apmsHandler.js`, montado en `index.js:131` como `/apms`. Header `Monetiser-Signature` (como el 1) pero secreto **solo global** (como el 2). Cola propia en memoria con reintentos, jitter y concurrencia (`WEBHOOK_QUEUE_CONCURRENCY`). Sin registro en Mongo. <br><br>**Consecuencias reales:** (a) un merchant que verifique `Monetiser-Signature` fallará **en silencio** los eventos de ciclo de vida, que van por `x-monetiser-signature`; (b) si el merchant tiene `signingSecret` propio y no hay `WEBHOOK_SECRET` global, los emisores 2 y 3 envían **sin firmar** — no se omiten, salen igual sin el header; (c) contradice lo que este DEV-LOG afirma de M2 Fase C ("el dispatcher firma por-merchant"): cierto solo para 1 de los 3. <br><br>Hoy no ha explotado solo porque no hay ningún merchant real verificando firmas. **Documentado tal cual en `openapi.yaml`. Pendiente de decidir:** unificar 2 y 3 sobre `webhookDispatcher` (ganan secreto por-merchant, reintentos y registro gratis, y queda una sola firma). Es cambio de contrato de cara al merchant — momento barato de hacerlo, precisamente por estar en test. |
| Contrato inconsistente capture vs refund | Media | `captureSchema` usa `amount` plano (entero, céntimos); `refundSchema` y `cancelSchema` usan `amountOfMoney: { amount, currencyCode }`. Mismo concepto, dos formas, en endpoints hermanos. Documentado tal cual en `openapi.yaml`. No rompe nada hoy (lo verificado fue con body vacío) pero confundirá a quien integre. |
| `x-api-key` transporta el keyId, no el secreto | Media | En modo simple (`API_KEY_SIMPLE_FALLBACK=true`), `validateApiKey()` busca por `keyId: rawKey` — es decir, el header lleva el `rawKeyId` (`mk_...`) y **el `rawSecret` no interviene**: el identificador actúa como credencial. Aceptable para Postman, no para producción. Es el motivo de que exista el modo HMAC. Documentado en `openapi.yaml` (securityScheme `ApiKeySimple`). |
| La firma HMAC usa `secretHash`, no el secreto | Baja — solo documentación | `hmacAuth.js` hace `computeSignature(doc.secretHash, stringToHash)`: la clave del HMAC es el SHA-256 del secreto, no el `rawSecret`. Quien integre debe hashear su secreto antes. No es un fallo, pero es contraintuitivo y no estaba escrito en ningún sitio. Ya documentado en `openapi.yaml`. |
| test-checkout.html no carga con iframe | Baja | El botón "Cargar" no funciona — workaround: abrir la URL directamente en el navegador |
| ~~Logs de debug en producción~~ | ✅ RESUELTO — 16 jul 2026 | **La deuda descrita aquí no era la real.** `fullBody` NO existía en ninguna parte del repo (era deuda fantasma: se limpió en algún momento y nadie actualizó este documento), y `tokenKeys` tenía UNA sola ocurrencia, no varias. `serverPaymentController.js` y `payNoPainConnector.js` no tenían nada que limpiar. **Lo que sí había y no estaba apuntado: el PAN se logueaba en dos sitios** — `proxyPciRoutes.js` (PROXY_PCI_TOKEN_RETRIEVED) y `pciProxyService.js` (PCI_PROXY_GET_RESULTS_OK). No llegó a filtrarse porque `sanitizeData()` de `logger.js` redacta por regex las claves con "pan" (el valor salía como `[REDACTED]`, por lo que quitarlos no perdió información), pero para SAQ A el PAN no debe llegar al logger y depender de un regex. Eliminados también `tokenKeys` y `tokenValue` (30 chars del token de tarjeta). Se conservan los ids (paymentId, merchantId, cardUuid, reference, brand). El sanitizador queda como red de seguridad, no como primera línea. |
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

### M3 — Panel de administración ✅ COMPLETADO (julio 2026)
**Objetivo:** UI en `/admin` para operar sin Postman ni Atlas.

**Contexto descubierto:** ya existía un panel a medias (herencia de versiones antiguas).
Conviven DOS paneles en `public/admin/`:
- `dashboard.html` + `dashboard.js` → el panel BUENO. Login por email+contraseña contra
  `/backoffice/auth/login` (modelo BackofficeUser, con roles). Tiene analíticas,
  transacciones con refund/cancel, gestión de usuarios, merchants y API keys. ES EL QUE SE USA.
- `index.html` + `app.js` → editor de reglas de routing antiguo (usa ADMIN_TOKEN).
  Preservado, accesible en `/admin/index.html`.

**Hecho en la sesión anterior (Fase A + fixes de datos):**
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

**Hecho en esta sesión (pestañas Merchants + API Keys):**
- Nueva pestaña **Merchants** en el dashboard (`tabBtnMerchants` / `tabMerchants`), visible
  solo para rol `superadmin` (mismo criterio que la pestaña Usuarios). Lista, crea y edita
  merchants (`merchantId`, nombre, país, plan, estado, webhookUrl).
- Backend: `src/routes/backofficeRoutes.js` gana `GET/POST /backoffice/merchants` y
  `PATCH /backoffice/merchants/:merchantId`, protegidos por sesión JWT + `requireRole('superadmin')`.
  Reutiliza el modelo `Merchant` de M2 — las rutas `/merchants` con `X-Admin-Token` siguen
  intactas para uso vía Postman/scripts, esto es el equivalente para el dashboard.
- Botón **"API Keys"** por fila de merchant abre un modal: lista las keys existentes
  (prefix, etiqueta, estado, último uso), permite crear una nueva (el `rawSecret` se muestra
  UNA SOLA VEZ tras crearla, con aviso) y revocar las activas.
- Backend: `GET/POST /backoffice/merchants/:merchantId/api-keys` y
  `DELETE /backoffice/merchants/:merchantId/api-keys/:keyId`, mismo criterio de auth.
  Reutiliza `apiKeyService.js` (las mismas funciones que ya usaba `/api-keys` con X-Admin-Token) —
  no se duplicó lógica de generación/hash de credenciales.
- **Bug preexistente corregido de paso**: el botón de la pestaña "Usuarios" tenía DOS
  atributos `id` en el mismo `<button>` (`id="tabBtnUsers" id="usersTab"`). El navegador
  solo respeta el primero, así que el código que la hacía visible para superadmin
  (`getElementById('usersTab')`) nunca encontraba el elemento — la pestaña de Usuarios
  llevaba tiempo invisible para todo el mundo. Corregido a un único id.

**Hecho en esta sesión (widgets expandibles):**
- Al tocar/clicar CUALQUIER widget del dashboard (no solo transacciones) se abre un
  modal con la vista ampliada de ese widget. Mecanismo genérico: cada widget tiene un
  listener de click a nivel de contenedor que llama a `openExpand(id)`; los elementos
  interactivos internos (filas de transacciones) hacen `stopPropagation()` para no
  disparar el expand a la vez que abren el detalle de la transacción.
- Por tipo de widget, la vista ampliada muestra:
  - **KPIs de volumen/nº transacciones** → gráfico de línea con la evolución diaria
    (reutiliza los datos de `/backoffice/analytics/timeline` ya cargados).
  - **KPI tasa de aprobación** → gráfico de línea de la tasa diaria (calculada
    client-side a partir de approved/count por día).
  - **KPI ticket medio** → gráfico de línea de volume/count por día.
  - **KPI tasa refund / tasa fallback** → no hay endpoint de serie temporal para
    estos dos en el backend todavía, así que se muestra una muestra filtrada de las
    últimas transacciones ya cargadas en cliente, con aviso explícito de que NO es
    el listado completo del período.
  - **Gráfico de evolución temporal / métodos de pago** → versión grande del mismo
    gráfico + tabla de datos completa debajo.
  - **Top países** → tabla completa (el widget colapsado solo muestra barras, sin
    truncar países).
  - **Últimas transacciones** → esta es la pieza grande: lista COMPLETA paginada
    (`GET /backoffice/transactions?page&limit&status&processor&country&q`), con
    filtros de estado/conector/país/búsqueda y paginación anterior/siguiente. No
    depende de lo cargado en cliente (solo 20 tx) — consulta el servidor de nuevo
    en cada cambio de filtro o página. Clic en una fila cierra el expand y abre el
    modal de detalle de transacción de siempre (refund/cancel incluidos).
- No se tocó el backend: `/backoffice/transactions` ya soportaba paginación y
  filtros desde antes, solo faltaba la UI que los usara más allá del top 10.

**Hecho en esta sesión (pestaña Reglas — cierra M3):**
- Nueva pestaña **Reglas** (`tabBtnRules` / `tabRules`), solo superadmin. Absorbe
  el editor viejo (`public/admin/index.html` + `app.js`, protegido por X-Admin-Token
  manual) dentro del dashboard nuevo, con sesión JWT en vez de pegar el token a mano.
- Mismas funciones que el editor viejo: cargar/guardar política JSON por merchant,
  atajos de reglas (5 presets), probar política contra una transacción de ejemplo,
  exportar/importar JSON, histórico de auditoría.
- Backend: `src/routes/backofficeRoutes.js` gana `/backoffice/rules/*`, protegidas
  por sesión JWT + `requireRole('superadmin')`, reutilizando `rulesController.js`
  TAL CUAL (cero lógica duplicada) — solo cambia el middleware de auth. Las rutas
  `/rules/*` con X-Admin-Token (`rulesRoutes.js`) siguen intactas por si algún
  script externo las usa directamente.
- Mejora sobre el editor viejo: el actor de auditoría (`x-admin-actor`) ya no
  depende de un header manual — se rellena solo con el email de la sesión de
  backoffice (`stampRulesActor` en backofficeRoutes.js).
- **Flags `FEATURE_RULE_*`**: `tryPolicy`, `getAudit`, `exportPolicy` e `importPolicy`
  en `rulesController.js` están detrás de flags de entorno. **Documentados al detalle en
  la sección 8 → "Flags de la pestaña Reglas"** (qué activa cada uno, qué botón depende de
  cuál, y por qué `FEATURE_RULE_AUDIT` es el crítico). Sigue sin confirmarse si están a `1`
  en Render — es la acción pendiente de Marcos. `getPolicy`/`upsertPolicy` (cargar/guardar,
  lo esencial) NO dependen de ningún flag, siempre funcionan.
- El editor viejo (`/admin/index.html`) queda ahora redundante pero no se ha
  tocado ni eliminado — decisión de Marcos si quiere retirarlo más adelante.

**M3 cerrado.** Pendiente de verificar en vivo — ver pruebas pendientes más abajo.

**Aprendizaje clave de esta sesión — TARJETAS DE TEST:**
Las tarjetas de test REALES de Paylands sandbox son las `4018810000100036` / `4018810001010010`
/ `4018810000150015` / `4018810000190011` (exp 12/34, CVV 123). La tarjeta `4507670001000009`
es INVENTADA y NO funciona (en 3DS deja la tx colgada en pending_3ds porque el challenge nunca
se resuelve → Paylands nunca manda webhook). NO usarla nunca.

**Nota sobre pagos colgados en pending_3ds:** las tx que quedan en pending_3ds con
webhookReceived:false son pruebas con tarjeta mala cuyo 3DS no se completó. El webhook de
cierre (webhooks.js) está bien montado y verificado; solo cierra tx cuando Paylands notifica
un pago realmente completado. Sin challenge 3DS, el cierre es síncrono (iframe.js).

### M4 — OpenAPI completa ✅ COMPLETADO (16 julio 2026)

**Objetivo:** documentar el contrato REAL de la API, no una versión idealizada.

**Entregable: `openapi.yaml` en la raíz del repo** (OpenAPI 3.1, v1.0.0).
23 rutas · 27 operaciones · 21 schemas · 4 webhooks salientes · 0 referencias rotas.
Validado con `js-yaml`.

**Decisión: una sola spec.** La antigua `openapi/monetiser.yaml` (v0.4.1) se ha
ELIMINADO y su contenido está portado íntegro a la nueva (`/initialize`, `/iframe`,
`/orchestration/decide`, `/rules/*`, schema `Policy`, webhook `payment.updated`).
Motivo: dos specs a medias es exactamente cómo este DEV-LOG acabó contradiciéndose.
Verificado antes de borrarla que **nada la referenciaba** — ni código, ni
`package.json`, ni Swagger UI. Era un documento suelto, no una pieza del sistema.

**Marcas de madurez** (`x-madurez` en cada operación): 21 estables · 1 experimental
(S2S, además con `deprecated: true` para que los generadores de clientes lo señalen)
· 4 internos (iFrame/proxy-pci) · 1 legado (`/initialize`).

**Todos los campos salen de los DTOs y validators reales.** Nada inventado.

**Hallazgos encontrados al escribirla** (ver sección 5 para el detalle):
1. Los webhooks salientes tienen TRES emisores distintos con firmas incompatibles
   (no es cosa del entorno de test: son literales en el código).
2. `capture` usa `amount` plano; `refund` y `cancel` usan `amountOfMoney.amount`.
3. En modo simple, `x-api-key` lleva el `rawKeyId`, no el `rawSecret`.
4. La firma HMAC usa `secretHash` (SHA-256 del secreto) como clave, no el secreto.

Ninguno se ha "arreglado" en la spec: están documentados tal como son, con aviso.

**Pendiente (no bloqueante):** publicar la spec en Swagger UI (`swagger-ui-express`)
en `/docs`, y escribir `docs/integration-guide.md`.

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
| ~~Eliminar logs de debug (fullBody, tokenKeys)~~ → ✅ HECHO 16 jul 2026. Eliminados el PAN, `tokenKeys` y `tokenValue` de `proxyPciRoutes.js` y `pciProxyService.js`. `fullBody` no existía (deuda fantasma). | — |
| Revocar el PAT de GitHub que estuvo publicado en CLAUDE.md (11-16 jul 2026) | **Alta — acción de Marcos** |
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

### Flags de la pestaña Reglas (`FEATURE_RULE_*`)

Estos tres flags gatean los botones de la pestaña **Reglas** del dashboard (`/admin`).
Se leen en `src/controllers/rulesController.js` (líneas 11-13) y solo se activan con el
valor exacto `1` (la comparación es `=== '1'`: `true`, `on` o `yes` NO funcionan).

| Flag | Qué activa en el backend | Botón del dashboard | Recomendado en Render |
|---|---|---|---|
| `FEATURE_RULE_TRY` | `tryPolicy` — dry-run del rule engine contra una transacción de ejemplo | **Probar** | `1` |
| `FEATURE_RULE_AUDIT` | `getAudit` (lectura del histórico) **y** la escritura de entradas de auditoría al guardar una política | **Histórico** | `1` |
| `FEATURE_RULE_EXPORT_UI` | `exportPolicy` **e** `importPolicy` | **Exportar** e **Importar** (los dos con el mismo flag) | `1` |

**Lo que hay que saber:**

- **Exportar e Importar comparten flag.** No se puede tener uno sin el otro.
- **`FEATURE_RULE_AUDIT` hace dos cosas, no una.** Además de mostrar el histórico, es lo que
  hace que se *escriban* las entradas de auditoría al guardar una política (rulesController.js
  líneas 78 y 217). Si está apagado, los cambios de reglas se guardan **sin dejar rastro** de
  quién los hizo — y ese histórico no se puede reconstruir a posteriori. Es el más importante
  de los tres.
- **Cargar y guardar políticas (`getPolicy` / `upsertPolicy`) NO depende de ningún flag.**
  Siempre funciona. Si un botón falla, las reglas no están rotas: falta el flag.
- Si un flag está apagado, el endpoint devuelve `404 {"error":"disabled"}` y la UI lo muestra
  como "función desactivada" nombrando el flag que falta (`public/admin/dashboard.js`,
  líneas 1026, 1056, 1074, 1098). No rompe nada.

**Acción pendiente de Marcos:** poner los tres a `1` en Render → Environment.
No se ha tocado la configuración de Render desde aquí.

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

*Última revisión: 16 julio 2026 — Ciclo de vida DEFERRED VERIFICADO end-to-end al COMPLETO: refund (total y parcial), capture y cancel confirmados funcionando contra Paylands real. Claves del arreglo: (1) endpoints reales `/payment/confirmation` y `/payment/cancellation`; (2) operative AUTHORIZATION→DEFERRED en las 3 funciones de creación de orden; (3) mapeo del status `PENDING_CONFIRMATION`→`authorized` en el webhook; (4) declarados `lastWebhookAt`/`lastWebhookRaw` en el esquema Transaction (Mongoose los descartaba en silencio); (5) fixes de validación en refundSchema y de normalización dummyCard. Lección operativa recurrente: confirmar SIEMPRE que Render terminó de desplegar antes de probar — varios falsos negativos se debieron a probar contra el código viejo. M1, M2 y M3 completados. Bloqueante crítico pendiente: S2S acepta PAN en crudo (incompatible con SAQ A) — decidir tokens-only vs scope PCI mayor antes de M5. Tarjetas test buenas: 4018810...*

*Sesión 16 julio 2026 (tarde, cont.) — M4 COMPLETADO: `openapi.yaml` en la raíz (OpenAPI 3.1, v1.0.0, 23 rutas / 27 operaciones / 21 schemas / 4 webhooks salientes / 0 refs rotas, validado con js-yaml). Una sola spec: eliminada `openapi/monetiser.yaml` y portado su contenido íntegro tras verificar que nada la referenciaba. Cada campo sale de los DTOs y validators reales. S2S documentado como `experimental` + `deprecated: true` conforme a la decisión A. **Cuatro hallazgos al escribirla, todos documentados en la spec y anotados en la sección 5** — el grave es el primero: (1) los webhooks salientes tienen TRES emisores independientes con firmas incompatibles — `webhookDispatcher` (`Monetiser-Signature`, secreto por-merchant, reintentos, log), `sendWebhookIfAny` en paymentsController (`x-monetiser-signature`, solo secreto global, sin reintentos, sin log) y `core/webhookService` vía /apms (`Monetiser-Signature` pero solo secreto global, cola propia). Un merchant que verifique un header fallará el otro en silencio, y los emisores 2 y 3 envían SIN FIRMAR si el merchant tiene secreto propio pero no hay WEBHOOK_SECRET global. **No es un artefacto del entorno de test**: los nombres de cabecera son literales en el código, sin condicionales de entorno — en producción pasaría exactamente igual. Hoy no ha explotado solo porque no hay ningún merchant verificando firmas; (2) `capture` usa `amount` plano mientras `refund`/`cancel` usan `amountOfMoney.amount`; (3) en modo simple `x-api-key` lleva el keyId, no el secreto — el identificador actúa como credencial; (4) la firma HMAC usa `secretHash` (SHA-256 del secreto) como clave, no el secreto. Nada de esto se ha "arreglado" en la spec: está documentado tal como es.*

*Sesión 16 julio 2026 (tarde) — Tarea 1, deuda técnica menor. (1a) Eliminado el PAN de los logs: `proxyPciRoutes.js` (PROXY_PCI_TOKEN_RETRIEVED) y `pciProxyService.js` (PCI_PROXY_GET_RESULTS_OK) lo logueaban, junto con `tokenKeys` y 30 chars del token de tarjeta. No llegó a filtrarse porque `sanitizeData()` de `logger.js` lo redactaba por regex — el valor salía como `[REDACTED]`, así que quitarlos no perdió información — pero para SAQ A el PAN no debe llegar al logger. Corregido: el DEV-LOG describía una deuda que no existía (`fullBody`: cero ocurrencias en todo el repo) y no mencionaba la que sí existía (el PAN). `serverPaymentController.js` y `payNoPainConnector.js` estaban limpios. (1b) Documentados `FEATURE_RULE_TRY`/`AUDIT`/`EXPORT_UI` en la sección 8 — hallazgo relevante: `FEATURE_RULE_AUDIT` no solo muestra el histórico, también gatea la ESCRITURA de las entradas de auditoría (rulesController.js:78 y :217); apagado, los cambios de reglas se guardan sin rastro de autor y no se pueden reconstruir. Pendiente de Marcos: poner los tres a `1` en Render. Seguridad: retirado de CLAUDE.md el PAT de GitHub que estuvo publicado en el repo público del 11 al 16 de julio (troceado en dos mitades, lo que evitó que el secret scanning de GitHub lo auto-revocara) — Marcos lo revoca por su lado; quitarlo del archivo no lo borra del historial. Limpiadas además varias contradicciones internas del documento: capture/cancel figuraban a la vez como "verificados" y "sin verificar", y la sección 11 aún decía `operative: AUTHORIZATION`.*

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
| Autorizacion | POST /:merchantId/payments/hosted | POST /payment (**operative: DEFERRED**) | ✅ VERIFICADO |
| Refund (total/parcial) | POST /payments/:paymentId/refund | POST /payment/refund (order_uuid + amount opcional) | ✅ VERIFICADO end-to-end contra Paylands real (16 jul) |
| Captura | POST /payments/:paymentId/capture | **POST /payment/confirmation** (order_uuid + amount opcional) | ✅ VERIFICADO end-to-end contra Paylands real (16 jul) |
| Cancelacion (void) | POST /payments/:paymentId/cancel | **POST /payment/cancellation** (order_uuid, solo pre-captura) | ✅ VERIFICADO end-to-end contra Paylands real (16 jul) |

### Ciclo de vida de una transaccion

```
pending
  └─ pending_3ds
       └─ authorized       ← ✅ verificado (webhook PENDING_CONFIRMATION → authorized)
            ├─ captured / partially_captured   ← ✅ verificado (POST /payment/confirmation)
            ├─ cancelled                       ← ✅ verificado (POST /payment/cancellation, solo pre-captura)
            └─ refunded / partially_refunded   ← ✅ verificado (POST /payment/refund)
  └─ declined
  └─ error
```

Los cuatro estados están confirmados end-to-end contra Paylands sandbox real (16 jul 2026).
Requisito: la orden debe crearse con `operative: DEFERRED` — con `AUTHORIZATION` el dinero se
mueve al instante y no hay nada que confirmar ni cancelar.

### Pruebas pendientes

~~1. Refund real~~ · ~~2. Capture real~~ · ~~3. Cancel real~~ — ✅ **LOS TRES VERIFICADOS**
end-to-end contra Paylands real (16 jul 2026). Traza de la verificación de cancel:
`PAYNOPAIN_CHARGE_TOKEN_3DS_URL` → webhook `PENDING_CONFIRMATION` → `authorized` →
`POST /payments/{id}/cancel` → webhook `CANCELLED` → `PAYNOPAIN_CANCEL_OK` →
`CANCEL.RESPONSE {"status":"canceled"}` (200). Ya no hay nada pendiente en este bloque.
4. Verificar en los tres casos (refund/capture/cancel) que el webhook
   saliente al merchant notifica el estado correcto.
5. **Dashboard M3 (nuevo, sin probar en vivo)**: login como superadmin en
   `https://orquestacion-def-test.onrender.com/admin` → pestaña "Merchants"
   debe verse (antes no se veía tampoco la de "Usuarios" por el bug de id
   duplicado, ya corregido). Probar: listar merchants, crear uno nuevo, editarlo,
   abrir "API Keys" de un merchant, crear una key (confirmar que el rawSecret
   se muestra una vez), revocarla y confirmar que desaparece de la lista activa.
6. **Widgets expandibles (nuevo, sin probar en vivo)**: en la pestaña Dashboard,
   tocar cada widget uno por uno y confirmar que abre el modal ampliado sin
   errores en consola: KPIs (gráfico de línea), gráfico de evolución temporal
   y métodos de pago (gráfico grande + tabla), top países (tabla completa),
   y sobre todo "Últimas transacciones" → probar los filtros (estado, conector,
   país, búsqueda) y la paginación anterior/siguiente contra datos reales.
   Confirmar que clicar una fila de transacción dentro del expand cierra el
   modal y abre el detalle de siempre (con refund/cancel si aplica).
7. **Pestaña Reglas (nuevo, sin probar en vivo, cierra M3)**: cargar la política
   de `demo-merchant`, guardar un cambio, probar los 5 presets, usar "Probar"
   con una tarjeta de ejemplo y confirmar la explicación. Si "Probar",
   "Exportar", "Importar" o "Histórico" devuelven "función desactivada" —
   revisar en Render si `FEATURE_RULE_TRY`, `FEATURE_RULE_EXPORT_UI` y
   `FEATURE_RULE_AUDIT` están puestas a `1`; si no, decidir si activarlas.

Esto forma parte de M2/M3 y debe verificarse en sandbox antes de produccion.
