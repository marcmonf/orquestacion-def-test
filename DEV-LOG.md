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
| **S2S no cumple el objetivo "Monetiser nunca toca el PAN"** | **CRÍTICA — antes de M5 (PCI SAQ A)** | `POST /:merchantId/payments/server` acepta `cardPaymentMethodSpecificInput.card.cardNumber` en crudo en el body — a diferencia de Hosted Checkout (ProxyFields), aquí el PAN sí transita por la API de Monetiser. Además, **`payNoPainConnector.js` no tiene función `authorize()`** — solo `createOrder`/`createOrder3DS` (estilo Hosted, con redirect) y `chargeWithToken`. Como la política por defecto de cualquier merchant sin reglas custom es `defaultConnector: 'dummyCard'`, el S2S "funciona" hoy solo contra el conector de mentira; si una regla llegase a enrutar S2S hacia `payNoPain` reventaría con `connector.authorize is not a function`. **Verificado que hoy el PAN no se loguea ni se persiste en ningún punto del código** (ni en `Transaction`, ni en `auditLogger`, ni en `PaymentAttempt`, ni en los logs de `payNoPainConnector.js`) — pero aceptar el PAN en el body de la API ya pone a Monetiser en un scope PCI distinto (no SAQ A) para ese flujo concreto, y es incompatible con el objetivo declarado del proyecto. **Decisión pendiente antes de avanzar en S2S real:** o bien (a) S2S solo acepta tokens ya generados vía ProxyFields/hosted tokenization (nunca PAN en crudo), o (b) se acepta que S2S implica un scope PCI mayor y se documenta así explícitamente. Mientras no se decida, NO usar S2S con tarjetas reales ni de test — usar Hosted Checkout para generar transacciones de prueba contra PayNoPain real. |
| ~~Modelo Merchant en MongoDB~~ | ✅ M2 COMPLETADO | Modelo `Merchant` unificado con campos operativos (plan, status, webhookUrl, signingSecret, serviceUuid, templateUuid, branding). Rutas `/merchants` montadas y protegidas por X-Admin-Token. Dispatcher firma por-merchant. Detalle completo en sección 6 (M2). |
| ~~Panel de administración `/admin`~~ | ✅ M3 COMPLETADO | Dashboard con analíticas, transacciones (refund/cancel/widgets expandibles), usuarios, merchants, API keys y motor de reglas. Ver sección 6 (M3). |
| Capture/cancel Paylands sin verificar | Alta | `POST /payment/capture` y `POST /payment/cancel` están conectados en el código (connector + controller) pero son INFERENCIA por analogía con refund — nunca se han probado contra el sandbox real. Solo refund está confirmado (`POST /payment/refund`). Ver sección 11. |
| Flags FEATURE_RULE_* sin confirmar en Render | Media | `FEATURE_RULE_TRY`, `FEATURE_RULE_AUDIT`, `FEATURE_RULE_EXPORT_UI` gatean los botones Probar/Histórico/Exportar/Importar de la pestaña Reglas. No sabemos si están a `1` en Render — si no lo están, esos botones devuelven "función desactivada" (no rompe nada, pero conviene revisar). Cargar/guardar política NO depende de ningún flag. |
| Editor de reglas viejo (`/admin/index.html` + `app.js`) | Baja | Redundante desde que existe la pestaña Reglas del dashboard nuevo (mismo backend). Sigue ahí sin usarse ni eliminarse — decisión de Marcos si lo retira. |
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
- **OJO — sin verificar**: `tryPolicy`, `getAudit`, `exportPolicy` e `importPolicy`
  en `rulesController.js` están detrás de flags de entorno (`FEATURE_RULE_TRY`,
  `FEATURE_RULE_AUDIT`, `FEATURE_RULE_EXPORT_UI`) que no sabemos si están activadas
  en Render. Si no lo están, esos botones devuelven 404 y la UI lo muestra como
  "función desactivada" con el nombre exacto del flag que falta — no rompe nada,
  pero conviene revisar en Render qué flags están puestas. `getPolicy`/`upsertPolicy`
  (cargar/guardar, lo esencial) NO dependen de ningún flag, siempre funcionan.
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

*Última revisión: 12 julio 2026 (sesión tarde) — M3 CERRADO: nueva pestaña Reglas absorbe el editor viejo (index.html/app.js) sobre sesión JWT de backoffice, reutilizando rulesController.js sin cambios; el actor de auditoría ahora se rellena solo con el email de sesión. OJO: "Probar"/"Exportar"/"Importar"/"Histórico" dependen de flags de entorno (FEATURE_RULE_TRY/EXPORT_UI/AUDIT) sin confirmar en Render — cargar/guardar política no depende de ningún flag. Antes de eso, en la misma sesión: al tocar cualquier widget del dashboard se abre una vista ampliada (KPIs con evolución temporal, gráficos grandes + tabla, "Últimas transacciones" con listado completo paginado y filtrable contra `/backoffice/transactions`). Y antes: pestañas Merchants y API Keys (`/backoffice/merchants` + `/backoffice/merchants/:id/api-keys`, solo superadmin), reutilizando el modelo Merchant (M2) y apiKeyService.js; de paso, corregido bug preexistente de id duplicado que dejaba la pestaña "Usuarios" invisible para todos. Sesión de la mañana: descubierto y reconectado a Paylands real el sistema legacy de capture/refund/cancel (paymentsController.js + Operation), con fix de seguridad (ownership de merchant) y fix de lógica (refund/capture sin exigir captura previa). refund usa endpoint verificado (POST /payment/refund); capture (POST /payment/capture) y cancel (POST /payment/cancel) son inferencia, sin verificar aún. Pendiente: verificar TODO en Postman/navegador contra Render cuando Marcos tenga acceso al Mac — ver sección 11 (7 pruebas pendientes). M1, M2 y M3 completados. Tarjetas test buenas: 4018810...*

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
| Cancelacion (void) | POST /payments/:paymentId/cancel | POST /payment/cancel (order_uuid, solo pre-captura) | ⚠️ CONECTADO pero endpoint Paylands es INFERENCIA — SIN VERIFICAR contra sandbox real |

### Ciclo de vida de una transaccion

```
pending
  └─ pending_3ds
       └─ authorized       ← ya funciona
            ├─ captured / partially_captured   ← conector conectado (sin verificar)
            ├─ cancelled                       ← conector conectado (sin verificar, solo pre-captura)
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
3. **Cancel real**: `POST /payments/{paymentId}/cancel` mismo patron de auth.
   Solo funciona sobre transacciones `authorized` SIN capturar todavia (si ya
   hay capture, el endpoint devuelve 409 y hay que usar refund). Prioridad
   igual que capture: confirmar si `POST /payment/cancel` es la ruta real de
   Paylands.
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
