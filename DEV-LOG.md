# DEV-LOG — Monetiser Payment Orchestration Platform

> Repositorio: `marcmonf/orquestacion-def-test` · Rama: `main`
> Stack: Node.js + Express + MongoDB Atlas · Despliegue: Render
> URL de producción: `https://orquestacion-def-test.onrender.com`
> Última actualización: junio 2025

---

## Índice

1. [Visión general del producto](#1-visión-general-del-producto)
2. [Arquitectura del sistema](#2-arquitectura-del-sistema)
3. [Fases completadas](#3-fases-completadas)
4. [Problemas encontrados y cómo se resolvieron](#4-problemas-encontrados-y-cómo-se-resolvieron)
5. [Gaps actuales y deuda técnica](#5-gaps-actuales-y-deuda-técnica)
6. [Hoja de ruta — próximos hitos](#6-hoja-de-ruta--próximos-hitos)
7. [Guía de implementación por hito](#7-guía-de-implementación-por-hito)
8. [Elementos de seguridad — implementados y pendientes](#8-elementos-de-seguridad--implementados-y-pendientes)
9. [Dónde ver trazas y logs en bruto](#9-dónde-ver-trazas-y-logs-en-bruto)
10. [Variables de entorno necesarias](#10-variables-de-entorno-necesarias)
11. [Referencia rápida de endpoints](#11-referencia-rápida-de-endpoints)

---

## 1. Visión general del producto

Monetiser es una **Payment Orchestration Platform (POP) SaaS B2B** orientada al mercado europeo. Su función central es actuar como intermediario inteligente entre los merchants (tiendas online, plataformas) y los PSPs (Payment Service Providers / adquirentes).

**Propuesta de valor:**
- Un único punto de integración para el merchant, independientemente del adquirente.
- Routing inteligente de transacciones mediante reglas configurables (por BIN, importe, país, scheme, tipo de tarjeta).
- Fallback automático entre adquirentes si el principal falla.
- iFrame propio que oculta al merchant toda la complejidad de PCI DSS.
- Webhooks salientes normalizados: el merchant recibe siempre el mismo contrato de mensaje, sin importar qué adquirente procesó el pago.

**Decisión arquitectónica clave:**
El iFrame de Monetiser es el único punto de contacto entre el usuario final y la página de pago. El routing al adquirente ocurre de forma invisible. El merchant solo embebe una URL de iFrame; nunca ve dos experiencias de usuario distintas según el adquirente.

---

## 2. Arquitectura del sistema

### Flujo completo de un pago

```
Merchant backend
    │
    ├─ POST /:merchantId/payments/server     → Flujo S2S (datos de tarjeta en el body)
    │                                           Auth → Rate limit → Rule Engine → Conector
    │
    └─ POST /:merchantId/payments/hosted     → Flujo Hosted Checkout
           │                                   Crea Transaction + hostedCheckoutId
           │                                   Devuelve redirectUrl → /hpp/:hostedCheckoutId
           │
           ↓
    GET /hpp/:hostedCheckoutId               → Construye URL firmada → redirige a /:merchantId/iframe
           │
           ↓
    GET /:merchantId/iframe?paymentId=...    → Sirve iframe.html con branding del merchant
           │                                   Incluye sub-iFrame de ProxyFields (Paylands)
           │
           ↓
    Usuario introduce PAN en sub-iFrame     → PAN nunca toca servidores de Monetiser
           │                                   ProxyFields tokeniza el PAN en Paylands
           │
           ↓
    POST /:merchantId/proxy-pci/session     → Obtiene token de sesión PCI
    POST /:merchantId/proxy-pci/charge      → Cobro S2S con token PCI (chargeWithToken)
           │
           ↓
    Paylands procesa → POST /webhooks/paynopain   → Monetiser verifica firma → actualiza Transaction
           │                                         → WebhookEvent (auditoría)
           │
           ↓
    webhookDispatcher.enqueue()             → HTTP POST al callbackUrl del merchant
                                              Firma HMAC saliente · retry con backoff exponencial
```

### Componentes principales

| Archivo / Módulo | Función |
|---|---|
| `index.js` | Entry point, conexión MongoDB, montaje de routers |
| `src/middleware/auth.js` | Auth canónico por API key (MongoDB + fallback env) |
| `src/middleware/rateLimiterPayments.js` | Doble límite IP + merchant en rutas de pago |
| `src/services/paymentService.js` | Orquesta Rule Engine + connectors + fallback |
| `src/core/ruleEngineV2.js` | Evalúa política de routing por contexto de transacción |
| `src/services/connectorRegistry.js` | Registro de conectores activos (dummyCard, payNoPain) |
| `src/connectors/paynopain/payNoPainConnector.js` | Conector real Paylands (Hosted + chargeWithToken) |
| `src/connectors/dummy/dummyCardConnector.js` | Conector simulado para tests |
| `src/routes/webhooks.js` | Webhook entrante de Paylands → actualización de Transaction |
| `src/services/webhookDispatcher.js` | Webhook saliente al merchant con HMAC + retry |
| `src/services/pciProxyService.js` | Sesión PCI + tokenización con Proxy PCI de Paylands |
| `src/routes/proxyPciRoutes.js` | Endpoints /proxy-pci/session y /proxy-pci/charge |
| `src/routes/iframe.js` | Sirve iframe.html con runtime inyectado |
| `public/iframe.html` | iFrame del checkout con sub-iFrame de ProxyFields |
| `src/models/Transaction.js` | Modelo central de estado de cada pago |
| `src/models/MerchantApiKey.js` | API keys en MongoDB (hash SHA-256) |
| `src/models/WebhookEvent.js` | Auditoría de webhooks entrantes |
| `src/models/WebhookLog.js` | Log de intentos de entrega saliente |
| `src/models/TraceLog.js` | Trazas de sistema en MongoDB |
| `src/utils/logger.js` | Logger estructurado → MongoDB + consola |
| `src/utils/cryptoUtils.js` | AES-256-GCM, HMAC helpers, maskPan |
| `openapi/monetiser.yaml` | Especificación OpenAPI v0.4.1 |

---

## 3. Fases completadas

### Fase 1 — Infraestructura base
**Estado: ✅ Completada**

- Proyecto Node.js + Express inicializado.
- Conexión a MongoDB Atlas con Mongoose.
- Despliegue continuo en Render (auto-deploy desde `main`).
- Middleware globales: CORS, Helmet, express-mongo-sanitize, xss-clean, hpp.
- Rate limiting global (`src/middleware/rateLimiterGlobal.js`).
- Sistema de logging estructurado con escritura a colección `tracelogs` en MongoDB.
- Audit logger separado (`src/logs/auditLogger.js`).
- i18n básico (`src/i18n/`).

### Fase 2 — Flujo S2S (server-to-server)
**Estado: ✅ Completada**

- Endpoint `POST /:merchantId/payments/server` con auth + rate limit.
- Conector `dummyCard` para tests sin PSP real.
- Modelo `Transaction` en MongoDB con todos los campos necesarios.
- Audit log de cada intento de pago.
- Analytics básicos en `/transactions/analytics/*`.

### Fase 3 — Rule Engine V2
**Estado: ✅ Completada**

- Motor de reglas configurable por merchant (`src/core/ruleEngineV2.js`).
- Evaluación por: amount, currency, BIN, issuerCountry, scheme, cardType, method.
- CRUD de políticas: `GET/PUT /rules/:merchantId`.
- Endpoint de dry-run: `POST /rules/try`.
- Historial de cambios: `GET /rules/:merchantId/audit`.
- Fallback configurable entre conectores si el principal falla o declina.
- Métricas de conectores en memoria (`src/orchestrator/metrics/metricsService.js`).

### Fase 4 — Conector real PayNoPain (Paylands)
**Estado: ✅ Completada**

- Conector `payNoPain` integrado en el registry.
- Autenticación HTTP Basic Auth (`Authorization: Basic base64(apiKey:)`).
- Campo `signature` = valor literal de `PAYNOPAIN_SIGNATURE` (no un hash calculado).
- Endpoint sandbox: `POST https://api.paylands.com/v1/sandbox/payment`.
- Orden real verificada en portal Paylands.
- `processorReference` = `orderUuid` devuelto por Paylands, guardado en `Transaction`.

### Fase 5 — Flujo Hosted Checkout con Paylands
**Estado: ✅ Completada**

- Endpoint `POST /:merchantId/payments/hosted` crea Transaction en estado `hosted_pending`.
- Genera `hostedCheckoutId` único, guardado en Transaction.
- `GET /hpp/:hostedCheckoutId` construye URL firmada y redirige al iFrame.
- El merchant recibe `redirectUrl` que lleva al usuario directamente a la página de pago de Paylands.
- Webhook de vuelta: `POST /webhooks/paynopain` verifica firma y actualiza Transaction.

### Fase 6 — iFrame propio con Proxy PCI
**Estado: ✅ Completada (verificación de producción pendiente)**

- iFrame de Monetiser (`public/iframe.html`) con branding configurable por merchant.
- Sub-iFrame de ProxyFields (Paylands) para captura del PAN — el PAN nunca toca los servidores de Monetiser.
- `POST /:merchantId/proxy-pci/session` obtiene token de sesión del Proxy PCI de Paylands.
- `POST /:merchantId/proxy-pci/charge` ejecuta cobro S2S usando el token PCI.
- Content-Security-Policy configurada en `src/routes/iframe.js`:
  - `script-src` incluye `pci-proxy-api.paynopain.com`.
  - `frame-src` incluye `pci-proxy-sandbox.paynopain.com`.
  - `frame-ancestors 'none'` para prevenir clickjacking.
- Guard HMAC opcional en iFrame (`FEATURE_IFRAME_GUARD=1`).

### Fase 7 — Auth unificado + API keys en MongoDB
**Estado: ✅ Completada**

- Middleware canónico `src/middleware/auth.js`: valida `x-api-key` + `x-merchant-id`.
- Prioridad: MongoDB (hash SHA-256) → fallback a `API_KEYS_MAP` / `API_KEY` en env.
- Modelo `MerchantApiKey`: hash SHA-256, prefijo visible, estado activo/revocado, lastUsedAt, expiresAt.
- Endpoints de gestión: `POST/GET/DELETE /api-keys/:merchantId` (protegidos por `X-Admin-Token`).
- `src/middleware/apiKeyAuth.js` es un re-export de `auth.js` para compatibilidad hacia atrás.
- Script de seed: `src/scripts/seedDemoMerchantKey.js`.

### Fase 8 — Webhook end-to-end
**Estado: ✅ Código completo / ⚠️ Verificación en producción pendiente**

- `POST /webhooks/paynopain`: verifica firma de Paylands (comparación timing-safe).
- Mapeo de estados Paylands → estados Monetiser.
- Guarda `WebhookEvent` en MongoDB para auditoría (incluyendo rawPayload).
- `webhookDispatcher.enqueue()`: encola y procesa en background.
- Firma HMAC saliente: `Monetiser-Signature: t=<ts>, v1=<hex>` (requiere `WEBHOOK_SECRET` en env).
- Retry automático con backoff exponencial (hasta `WEBHOOK_MAX_RETRIES=6` intentos).
- `GET /webhooks` para consultar histórico de eventos.

---

## 4. Problemas encontrados y cómo se resolvieron

### P1 — Mongoose descarta campos no declarados en el schema silenciosamente
**Problema:** El campo `hostedCheckoutId` se guardaba correctamente en el request pero nunca se persistía en MongoDB. La búsqueda `Transaction.findOne({ hostedCheckoutId })` devolvía siempre `null` o un documento de una transacción distinta.

**Causa raíz:** Mongoose tiene `strict mode` activado por defecto. Si un campo no está declarado en el schema, lo descarta silenciosamente al hacer `.save()` sin devolver ningún error.

**Solución:** Añadir explícitamente `hostedCheckoutId: { type: String }` al schema de `Transaction`, junto con su índice correspondiente. Principio aprendido: **cualquier campo que se use en una consulta `.findOne()` debe estar declarado en el schema de Mongoose**.

### P2 — Error de autenticación contra la API de Paylands
**Problema:** Las peticiones a `https://api.paylands.com/v1/sandbox/payment` devolvían 401.

**Causa raíz:** La autenticación de Paylands es HTTP Basic Auth, no Bearer Token. El header correcto es `Authorization: Basic base64(apiKey:)` (con los dos puntos después del apiKey y sin contraseña).

**Solución:** Implementar `buildAuthHeader(apiKey)` en `payNoPainConnector.js` que codifica correctamente `${apiKey}:` en base64.

### P3 — El campo `signature` en Paylands no es un hash calculado
**Problema:** Se asumió que `signature` debía ser un HMAC calculado dinámicamente sobre el payload del pedido. Las órdenes se creaban pero Paylands las rechazaba o no las validaba correctamente.

**Causa raíz:** En el contexto de Paylands sandbox, `signature` es simplemente el valor literal de `PAYNOPAIN_SIGNATURE` (la clave secreta del servicio), no un hash calculado. Se pasa como string plano en el body del request.

**Solución:** Usar `signature: SIGNATURE` (el valor de la variable de entorno) directamente en el body de la orden, sin ningún procesamiento criptográfico adicional.

### P4 — Script HMAC de Postman apuntaba a la ruta incorrecta
**Problema:** Las peticiones desde Postman fallaban con errores de autenticación en algunos endpoints. El pre-request script de HMAC tenía `canonicalizedResource` hardcodeado a `/payments/server` en lugar de leer la ruta real de la request.

**Causa raíz:** El script de pre-request en la colección de Postman usaba una ruta estática en lugar de leer `pm.request.url.getPath()` para calcular el HMAC sobre la ruta real de cada request.

**Solución:** Actualizar el script de pre-request para usar `pm.request.url.getPath()` dinámicamente. Principio: **los scripts de HMAC en Postman siempre deben usar la ruta real de la request, nunca valores hardcodeados**.

### P5 — `callbackUrl` no se guardaba en Transaction desde el flujo Hosted Checkout
**Problema:** El dispatcher saliente no tenía URL de destino para notificar al merchant porque `tx.callbackUrl` era `null`.

**Causa raíz:** En el DTO de Hosted Checkout, el campo `callbackUrl` se leía de `feedbacks.webhookUrl`, pero la ruta de guardado en el controller asignaba el valor a una variable local y no lo persistía correctamente en el documento de Transaction.

**Solución:** Verificar que `callbackUrl: callbackUrl || null` aparece explícitamente en el objeto pasado al constructor de `Transaction` antes de `txn.save()`. Verificación final: inspeccionar el documento en Atlas directamente tras la creación.

### P6 — Múltiples middlewares de auth con comportamientos inconsistentes
**Problema:** Existían varios archivos de middleware de autenticación (`apiKeyAuth.js`, `auth.js`, variantes en rutas antiguas) con lógicas distintas, causando que algunas rutas aceptaran requests sin autenticar.

**Causa raíz:** Evolución orgánica del codebase sin una decisión arquitectónica explícita sobre el middleware canónico.

**Solución:** Consolidar toda la lógica de auth en `src/middleware/auth.js`. Convertir `src/middleware/apiKeyAuth.js` en un re-export de `auth.js` para no romper imports existentes. Documentar que `auth.js` es el único punto de modificación.

### P7 — CSP bloqueaba el sub-iFrame de ProxyFields de Paylands
**Problema:** La Content-Security-Policy del iFrame de Monetiser bloqueaba la carga de la librería ProxyFields y el sub-iFrame de Paylands, impidiendo la captura del PAN.

**Causa raíz:** La CSP inicial era demasiado restrictiva: no incluía los dominios de Paylands en `script-src`, `connect-src` ni `frame-src`.

**Solución:** Actualizar el header CSP en `src/routes/iframe.js` para incluir:
- `script-src`: `https://pci-proxy-api.paynopain.com`
- `connect-src`: `https://pci-proxy-api.paynopain.com`
- `frame-src`: `https://pci-proxy-api.paynopain.com https://pci-proxy-sandbox.paynopain.com`

### P8 — Autenticación del Proxy PCI requiere un JWT separado
**Problema:** Se asumió que las credenciales de la API de Paylands (Basic Auth) servirían también para el Proxy PCI. El Proxy PCI devolvía 401.

**Causa raíz:** El Proxy PCI de Paylands (`pci-proxy-api.paynopain.com`) usa un flujo de autenticación diferente: requiere hacer `POST /customers` para obtener un JWT Bearer, que luego se usa en todas las llamadas posteriores.

**Solución:** Implementar `pciProxyService.js` con un sistema de caché del JWT en memoria (TTL de 23 horas) para evitar una llamada extra en cada transacción. Las credenciales son las mismas (`PAYNOPAIN_API_KEY` + `PAYNOPAIN_SIGNATURE`), pero el mecanismo de autenticación es distinto.

---

## 5. Gaps actuales y deuda técnica

### Gap 1 — No existe modelo `Merchant` completo
**Impacto: Bloquea el onboarding real de clientes.**

Hoy un merchant existe implícitamente si tiene una API key en MongoDB. No hay ningún documento que represente al merchant con: nombre legal, país, plan contratado, estado (activo/suspendido/prueba), URL de webhook por defecto, branding, ni configuración de notificaciones.

**Qué falta:**
- Modelo `Merchant` con los campos necesarios para el negocio.
- Endpoint `POST /merchants` para crear merchants (admin).
- Endpoint `GET/PUT /merchants/:merchantId` para gestión.
- Vincular `MerchantApiKey` al modelo `Merchant`.

### Gap 2 — No hay panel de administración funcional
**Impacto: Toda la operación del negocio requiere Postman o acceso directo a Atlas.**

Existe un directorio `public/admin` con archivos estáticos, pero sin lógica real. No es posible crear un merchant, ver sus transacciones en tiempo real, gestionar sus API keys, ni configurar sus reglas de routing desde una interfaz visual.

### Gap 3 — Webhook saliente no verificado en producción con WEBHOOK_SECRET
**Impacto: El ciclo end-to-end de notificación al merchant puede estar silenciosamente roto.**

El código del dispatcher es correcto. Si `WEBHOOK_SECRET` no está configurado en las variables de entorno de Render, el dispatcher aborta y no entrega nada — sin devolver error al caller.

**Verificación necesaria:**
1. Confirmar que `WEBHOOK_SECRET` existe en Render → Environment.
2. Hacer un pago de prueba con PayNoPain.
3. Verificar en Atlas (`webhooklogs`) que `deliveredAt` tiene valor y `lastStatus` es 2xx.

### Gap 4 — OpenAPI desactualizada
**Impacto: Bloquea la integración técnica de nuevos merchants sin soporte manual.**

El fichero `openapi/monetiser.yaml` está en v0.4.1 y no documenta:
- `POST /:merchantId/proxy-pci/session`
- `POST /:merchantId/proxy-pci/charge`
- `POST/GET/DELETE /api-keys/:merchantId`
- Los headers de autenticación (`x-api-key`, `x-merchant-id`)
- El contrato del webhook saliente (header `Monetiser-Signature`)

### Gap 5 — Auditoría PCI no formalizada
**Impacto: Necesario antes de cualquier contrato comercial real.**

El Proxy PCI delega la captura del PAN a Paylands (correcto para SAQ-A), pero no hay confirmación formal de que:
- Los logs no filtran PANs ni CVVs.
- Los campos de tarjeta que se persisten en Atlas son solo BIN + last4 (nunca el PAN completo).
- `cryptoUtils.maskPan()` se usa correctamente en todos los puntos donde se manipulan datos de tarjeta.

### Gap 6 — Sin billing ni modelo de negocio implementado
**Impacto: No es posible monetizar el servicio.**

No existe ninguna lógica de cobro de fees por transacción, ni tracking de volumen por merchant para facturación.

---

## 6. Hoja de ruta — próximos hitos

```
M1 [Esta semana]   Verificar webhook end-to-end en producción
M2 [Siguiente]     Modelo Merchant + onboarding mínimo
M3 [Demo]          Panel de administración funcional
M4 [Demo]          OpenAPI completa + guía de integración
M5 [Producto]      Segundo conector real (Nassau u otro adquirente europeo)
M6 [Comercial]     PCI SAQ-A — auditoría formal de logs y datos persistidos
M7 [SaaS]          Billing — fees por transacción, invoicing
M8 [Expansión]     APMs reales: Bizum, BLIK, MB WAY
M9 [Escala]        Multi-región, SLA formales, monitorización externa
```

---

## 7. Guía de implementación por hito

### M1 — Verificar webhook end-to-end

**Objetivo:** Confirmar que Paylands notifica → MongoDB se actualiza → merchant recibe notificación.

**Pasos:**
1. En Render → Environment, verificar que `WEBHOOK_SECRET` está definido (cualquier string aleatorio de ≥32 chars).
2. En Render → Environment, verificar que `SERVER_URL=https://orquestacion-def-test.onrender.com`.
3. Hacer un pago de prueba con el conector `payNoPain` desde Postman:
   ```
   POST https://orquestacion-def-test.onrender.com/inditex/payments/hosted
   Headers: x-api-key: <key>, x-merchant-id: inditex, Content-Type: application/json
   Body: { "order": { "amountOfMoney": { "amount": 100, "currencyCode": "EUR" } },
           "feedbacks": { "returnUrl": "https://example.com/return",
                          "webhookUrl": "https://webhook.site/<tu-uuid>" } }
   ```
4. Completar el pago en la página de Paylands sandbox.
5. Verificar en Atlas `webhookevents`: debe aparecer un documento con `source: 'paynopain'`.
6. Verificar en Atlas `webhooklogs`: debe aparecer `deliveredAt` con valor y `lastStatus: 200`.
7. Verificar en webhook.site que llegó la notificación con header `Monetiser-Signature`.

---

### M2 — Modelo Merchant + onboarding mínimo

**Objetivo:** Que un merchant pueda ser creado formalmente con todos los datos necesarios.

**Archivos a crear/modificar:**
- `src/models/Merchant.js` — Schema completo
- `src/routes/merchantRoutes.js` — CRUD admin
- `src/controllers/merchantController.js`
- `index.js` — montar `/merchants`

**Schema mínimo de Merchant:**
```javascript
{
  merchantId:    { type: String, required: true, unique: true },
  name:          { type: String, required: true },
  country:       { type: String, required: true },  // ISO 3166-1 alpha-2
  status:        { type: String, enum: ['active', 'suspended', 'trial'], default: 'trial' },
  plan:          { type: String, enum: ['starter', 'growth', 'enterprise'], default: 'starter' },
  webhookUrl:    { type: String },          // webhook por defecto
  signingSecret: { type: String },          // para firmar iFrame y HPP
  branding: {
    logoUrl:     { type: String },
    brandColor:  { type: String },
    name:        { type: String }
  },
  createdAt:     { type: Date, default: Date.now },
  updatedAt:     { type: Date, default: Date.now }
}
```

**Endpoints a implementar:**
```
POST   /merchants              → crear merchant (admin)
GET    /merchants/:merchantId  → obtener merchant
PUT    /merchants/:merchantId  → actualizar merchant
DELETE /merchants/:merchantId  → suspender (soft delete)
GET    /merchants              → listar todos (admin, con paginación)
```

Todos los endpoints de escritura protegidos con `adminAuth` (`X-Admin-Token`).
Los endpoints de lectura del propio merchant protegidos con `auth.js` (`x-api-key`).

---

### M3 — Panel de administración funcional

**Objetivo:** Una UI web en `/admin` que permita operar el negocio sin Postman ni Atlas.

**Funcionalidades mínimas:**
- Listar merchants y su estado.
- Ver transacciones de un merchant con filtros (fecha, estado, conector).
- Crear y revocar API keys de un merchant.
- Ver y editar la política de routing de un merchant.
- Ver el histórico de webhooks (entrantes y salientes) de una transacción.

**Stack recomendado:** HTML + vanilla JS (sin frameworks) servido desde `public/admin/`. Llamadas a la API con fetch + el `X-Admin-Token` guardado en sessionStorage.

**Consideración de seguridad:** El panel admin debe servirse solo desde IPs de confianza o con autenticación básica a nivel de servidor (Render no lo soporta nativamente — valorar Cloudflare Access o Basic Auth a nivel de Express).

---

### M4 — OpenAPI completa + guía de integración

**Objetivo:** Que un developer de un merchant pueda integrarse sin asistencia manual.

**Archivos a actualizar:**
- `openapi/monetiser.yaml` → versión 1.0.0
- `docs/integration-guide.md` (nuevo)
- `docs/webhook-guide.md` (nuevo)

**Endpoints que faltan en el OpenAPI actual:**
- `POST /:merchantId/proxy-pci/session`
- `POST /:merchantId/proxy-pci/charge`
- `POST /api-keys/:merchantId`
- `GET /api-keys/:merchantId`
- `DELETE /api-keys/:merchantId/:keyId`
- `POST /merchants` y derivados
- Todos los headers de autenticación como parámetros de seguridad

**Considerar:** Publicar el OpenAPI en Swagger UI (paquete `swagger-ui-express`) en `/docs`.

---

### M5 — Segundo conector real

**Objetivo:** Que el Rule Engine tenga al menos dos adquirentes reales entre los que elegir, validando la propuesta de valor core de Monetiser.

**Pasos:**
1. Identificar el segundo adquirente (Nassau, Redsys, Stripe, etc.).
2. Crear `src/connectors/<nombre>/<nombre>Connector.js` siguiendo la interfaz del conector existente:
   ```javascript
   module.exports = {
     ID: '<nombre>',
     authorize(paymentData) → Promise<{ success, status, processorReference, ... }>,
     capture({ transactionId, amount }) → Promise,
     void({ transactionId }) → Promise,
     refund({ transactionId, amount }) → Promise
   }
   ```
3. Registrar en `src/services/connectorRegistry.js`.
4. Añadir las variables de entorno necesarias en Render.
5. Configurar la política de routing de Inditex (merchant de demo) para enviar ciertos BINs al nuevo conector.
6. Verificar E2E con Postman.

---

### M6 — PCI SAQ-A

**Objetivo:** Confirmar que Monetiser es elegible para SAQ-A (el nivel más bajo de PCI DSS, reservado para merchants que delegan completamente la captura de datos de tarjeta a un tercero certificado).

**Checklist técnico:**
- [ ] Verificar que ningún log (consola, MongoDB `tracelogs`) contiene PANs, CVVs ni datos de expiración completos.
- [ ] Verificar que `cryptoUtils.maskPan()` se llama antes de cualquier log o persistencia de número de tarjeta.
- [ ] Confirmar que en `Transaction` solo se guardan `bin` (primeros 8 dígitos) y nunca el PAN completo.
- [ ] Revisar que el sub-iFrame de ProxyFields tiene `sandbox` attribute adecuado.
- [ ] Confirmar que `ALLOW_PAN_DECRYPT` está en `false` en producción (evita que se pueda llamar a `decryptAesGcm`).
- [ ] Documentar formalmente que el PAN nunca transita por los servidores de Monetiser en el flujo Proxy PCI.
- [ ] Contratar una auditoría SAQ-A con un QSA (Qualified Security Assessor) o usar el cuestionario de autoevaluación de PCI SSC.

---

### M7 — Billing

**Objetivo:** Cobrar a los merchants por las transacciones procesadas.

**Modelo de datos a crear:**
```javascript
// BillingRecord
{
  merchantId: String,
  period: String,         // "2025-06", "2025-07"...
  txCount: Number,
  txVolume: Number,       // suma de amount en euros
  feeFixed: Number,       // fee fijo por transacción
  feePercent: Number,     // fee porcentual
  totalFee: Number,
  currency: String,
  status: { type: String, enum: ['pending', 'invoiced', 'paid'] },
  invoiceUrl: String
}
```

**Integración:** Stripe Billing o Paddle para el cobro de cuotas a merchants. El tracking de transacciones ya existe en MongoDB.

---

## 8. Elementos de seguridad — implementados y pendientes

### Implementados

| Elemento | Dónde | Descripción |
|---|---|---|
| Autenticación por API key | `src/middleware/auth.js` | SHA-256 del token comparado con `keyHash` en MongoDB. Timing-safe comparison. |
| Rate limiting por IP | `src/middleware/rateLimiterGlobal.js` | 200 req/15min por IP. |
| Rate limiting por IP + merchant | `src/middleware/rateLimiterPayments.js` | Doble límite en rutas de pago. Bloqueo diferenciado. |
| Sanitización de inputs | `index.js` (middlewares globales) | `express-mongo-sanitize`, `xss-clean`, `hpp` activos globalmente. |
| Helmet | `index.js` | Headers HTTP de seguridad (X-Frame-Options, CSP base, etc.). |
| CSP estricta en iFrame | `src/routes/iframe.js` | `frame-ancestors 'none'`, allowlist explícita de dominios. |
| Firma HMAC en iFrame (opcional) | `src/core/iframeGuard.js` | Activable con `FEATURE_IFRAME_GUARD=1`. Previene reutilización de URLs de iFrame. |
| Firma HMAC en webhooks salientes | `src/services/webhookDispatcher.js` | Header `Monetiser-Signature: t=<ts>, v1=<hex>`. Incluye timestamp para prevenir replay. |
| Verificación timing-safe de firma Paylands | `src/routes/webhooks.js` | `crypto.timingSafeEqual` para prevenir ataques de timing. |
| PAN nunca en servidores | `public/iframe.html` + ProxyFields | El sub-iFrame de Paylands captura y tokeniza el PAN. Monetiser solo ve el token. |
| Máscara de PAN en logs | `src/utils/cryptoUtils.js` | `maskPan()` devuelve `BIN******last4`. |
| AES-256-GCM para datos sensibles | `src/utils/cryptoUtils.js` | Con IV aleatorio por operación y AAD. `decryptAesGcm` deshabilitado en producción. |
| Revocación de API keys | `src/services/apiKeyService.js` | `DELETE /api-keys/:merchantId/:keyId` marca `active: false` + `revokedAt`. |
| Expiración de API keys | `src/models/MerchantApiKey.js` | Campo `expiresAt` opcional. Se verifica en `validateApiKey()`. |
| Trust proxy | `index.js` | `app.set('trust proxy', 1)` para correcta detección de IP real en Render. |

### Pendientes

| Elemento | Prioridad | Descripción |
|---|---|---|
| WEBHOOK_SECRET en producción | Alta | Sin este secret el dispatcher no firma y no entrega. Verificar en Render. |
| Auditoría de logs contra PANs | Alta | Revisar que ningún campo de tarjeta llega a `tracelogs` sin enmascarar. |
| Rotación de PAYNOPAIN_SIGNATURE | Media | Proceso documentado para rotar el secret sin downtime. |
| 2FA para panel admin | Media | El panel admin actual solo usa `X-Admin-Token`. Añadir TOTP o IP allowlist. |
| Expiración automática de sesiones PCI | Media | La sesión del Proxy PCI debería expirar automáticamente si no se usa. |
| Protección CSRF en iFrame | Media | Verificar que `SameSite=Strict` en cookies (si se usan) y CSRF token en el form del iFrame. |
| Alertas por volumen anómalo | Baja | Si un merchant procesa 10× su volumen habitual en 1 hora, notificar. |
| Rotación automática de JWT del Proxy PCI | Baja | El JWT se renueva manualmente (TTL 23h en caché). Implementar renovación proactiva antes de expirar. |

---

## 9. Dónde ver trazas y logs en bruto

### MongoDB Atlas — colecciones de observabilidad

| Colección | Qué contiene | Filtros útiles |
|---|---|---|
| `tracelogs` | Todo lo que pasa por `logger.*` — routing decisions, errores, info de conectores | `paymentId`, `merchantId`, `level: 'error'` |
| `transactions` | Estado de cada pago. `processorReference` = orderUuid de Paylands | `merchantId`, `status`, `createdAt` |
| `webhookevents` | Notificaciones entrantes de PSPs con `rawPayload` original | `paymentId`, `source: 'paynopain'` |
| `webhooklogs` | Intentos de entrega saliente al merchant | `paymentId`, `deliveredAt: null` (sin entregar) |
| `merchantapikeys` | Keys de merchants (sin el hash en texto plano) | `merchantId`, `active: true` |
| `routingpolicies` | Historial de políticas de routing por merchant | `merchantId` |

### Desde Postman

```
GET /webhooks?paymentId=<uuid>          → WebhookEvents de un pago
GET /webhooks?status=failed&from=<iso>  → Webhooks fallidos en un rango de fechas
GET /transactions/<paymentId>           → Estado completo de una transacción
GET /transactions/analytics/summary     → Métricas agregadas
```

### Logs de Render (consola)

Los logs de consola incluyen la misma información que `tracelogs` en formato texto. Acceder en:
**Render Dashboard → orquestacion-def-test → Logs**

Formato de línea:
```
<ISO timestamp> <LEVEL> [<component>] <event> pid=<paymentId> mid=<merchantId> :: <message> { data }
```

---

## 10. Variables de entorno necesarias

### Críticas (servicio no arranca sin ellas)

| Variable | Descripción |
|---|---|
| `MONGO_URI` | URI de conexión a MongoDB Atlas |
| `PORT` | Puerto del servidor (Render lo asigna automáticamente) |

### PayNoPain / Paylands

| Variable | Descripción |
|---|---|
| `PAYNOPAIN_API_KEY` | API key de la cuenta Paylands |
| `PAYNOPAIN_SIGNATURE` | Signature literal del servicio Paylands |
| `PAYNOPAIN_SERVICE_UUID` | UUID del servicio configurado en Paylands |
| `PAYNOPAIN_ENV` | `sandbox` o `production` |

### Seguridad y firma

| Variable | Descripción |
|---|---|
| `WEBHOOK_SECRET` | Secret para firmar webhooks salientes (HMAC). Mínimo 32 chars. |
| `MERCHANT_SECRET` | Secret por defecto para firmar URLs de iFrame si no hay registro en Merchant |
| `ENCRYPTION_KEY` | 32 bytes en hex (64 chars) para AES-256-GCM en `cryptoUtils` |
| `API_KEY` | Fallback global de API key (legado, usar `API_KEYS_MAP` o MongoDB) |
| `API_KEYS_MAP` | JSON `{"merchantId": "apiKey"}` para fallback multi-merchant |
| `ADMIN_TOKEN` | Token para endpoints de administración (`X-Admin-Token`) |

### Opcionales / Feature flags

| Variable | Descripción |
|---|---|
| `SERVER_URL` | URL pública del servidor (para construir webhook URLs hacia Paylands) |
| `HPP_BASE_URL` | Base URL para construir redirectUrls de HPP |
| `MONGO_LOG_URI` | URI separado para la colección de trazas (por defecto usa `MONGO_URI`) |
| `LOG_LEVEL` | Nivel mínimo de logs: `error`, `warning`, `info`, `debug`, `trace` |
| `FEATURE_IFRAME_GUARD` | `1` para activar validación HMAC en carga del iFrame |
| `INITIALIZE_REQUIRE_API_KEY` | `true` para proteger `/initialize` con auth |
| `WEBHOOK_MAX_RETRIES` | Intentos máximos del dispatcher (default: 6) |
| `WEBHOOK_BACKOFF_BASE_MS` | Base del backoff exponencial en ms (default: 1000) |
| `WEBHOOK_TIMEOUT_MS` | Timeout por intento del dispatcher (default: 3000) |
| `ALLOW_PAN_DECRYPT` | `true` solo en desarrollo para activar `decryptAesGcm` |
| `ALLOWED_ORIGINS` | Lista de orígenes permitidos en CORS (separados por coma) |

---

## 11. Referencia rápida de endpoints

### Merchant (pagos)

```
POST /:merchantId/payments/server                        → Pago S2S
POST /:merchantId/payments/hosted                        → Crear Hosted Checkout
GET  /:merchantId/payments/hosted/:hostedCheckoutId/status → Estado del Hosted Checkout
POST /:merchantId/proxy-pci/session                      → Sesión PCI para ProxyFields
POST /:merchantId/proxy-pci/charge                       → Cobro con token PCI
GET  /:merchantId/iframe                                 → Cargar iFrame de checkout
GET  /hpp/:hostedCheckoutId                              → Redirect a iFrame firmado
```

Autenticación: `x-api-key: <merchant_api_key>` + `x-merchant-id: <merchantId>`

### Administración

```
GET    /rules/:merchantId              → Política de routing actual
PUT    /rules/:merchantId              → Crear/actualizar política
POST   /rules/validate                 → Validar política sin guardar
POST   /rules/try                      → Dry-run del rule engine
GET    /rules/:merchantId/audit        → Historial de cambios

POST   /api-keys/:merchantId           → Crear API key
GET    /api-keys/:merchantId           → Listar API keys
DELETE /api-keys/:merchantId/:keyId    → Revocar API key
```

Autenticación: `X-Admin-Token: <admin_token>`

### Observabilidad

```
GET /transactions                      → Listar transacciones (auth)
GET /transactions/:paymentId           → Detalle de transacción
GET /transactions/analytics/volume     → Volumen por período
GET /transactions/analytics/approval-rate → Tasa de aprobación
GET /transactions/analytics/summary    → Métricas agregadas
GET /webhooks                          → Histórico de WebhookEvents
GET /webhooks?paymentId=<id>           → Filtrar por pago
```

### Internos / PSPs

```
POST /webhooks/paynopain               → Recibe notificación de Paylands (no proteger con auth)
POST /orchestration/decide             → Consultar decisión del Rule Engine
```

---

*Este documento se actualiza con cada hito completado. Última revisión: junio 2025.*
