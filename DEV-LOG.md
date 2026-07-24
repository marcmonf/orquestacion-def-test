# DEV-LOG — Monetiser Payment Orchestration Platform

> Repositorio: `marcmonf/orquestacion-def-test` · Rama: `main`
> Stack: Node.js + Express + MongoDB Atlas
> URL de producción: `https://orquestacion-def-test.onrender.com`
> **Despliegue: Render, SIEMPRE MANUAL.** No hay auto-deploy y nunca lo ha habido —
> Marcos lanza cada despliegue a mano desde el panel. **Un commit en `main` NO está
> en producción.** Si algo "no funciona" en el servidor, lo primero a descartar es
> que nadie haya desplegado todavía.
> Última actualización: 20 julio 2026

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
| `src/rules/ruleEngineV2.js` | Evalúa política de routing por contexto de transacción. **(Este DEV-LOG decía `src/core/ruleEngineV2.js` — ruta incorrecta, corregida 16 jul 2026. El motor vive en `src/rules/`, no en `src/core/`.)** |
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
| **`/apms/payments` era un endpoint de pago PÚBLICO, sin validación y con PAN en crudo** (16 jul 2026) | Stack de pago paralelo heredado de una versión antigua, montado en `index.js` y nunca revisado. Tres fallos apilados: (1) su auth era opt-in vía `APMS_REQUIRE_API_KEY`, variable que **no existe en el repo ni en Render** → `apiKeyAuth` quedaba en `(req,res,next)=>next()`; (2) `paymentValidator.js` exporta el schema de Joi y acto seguido le **machaca su `.validate`** con el helper del propio módulo (línea 93), así que `paymentSchema.validate(tx)` devolvía una función en vez de un resultado y `{ error }` era SIEMPRE `undefined` — no rechazaba nada, en silencio, desde que se escribió; (3) aceptaba `cardNumber` en crudo y procesaba contra conectores simulados. | **Retirado por completo** (14 archivos + el montaje). Verificado en vivo antes de borrar: `POST /apms/payments` con body vacío y sin credenciales devolvía `200` en producción, mientras el mismo intento contra `/payments/hosted` devolvía `401`. Aislamiento comprobado (nada fuera de la isla lo requería, ningún test lo tocaba) y suite igual que la línea base: 119/128. **Lección: un endpoint montado y olvidado es peor que código muerto — el código muerto no acepta tarjetas.** Nota: el `.validate` machacado sigue en `paymentValidator.js`; ya no tiene víctima (`routes/payments.js` usa el helper correctamente, destructurando), pero es una trampa para código futuro que haga `require('paymentValidator').validate(obj)` esperando Joi. No se toca por estar en la ruta del ciclo de vida verificado. |
| **Segunda hornada de endpoints legacy peligrosos, montados y olvidados** (17 jul 2026) | Auditoría de código muerto pedida por Marcos. Cuatro hallazgos en rutas VIVAS: (1) `PUT`/`DELETE /transactions/:paymentId` operaban por `paymentId` **sin comprobar la pertenencia al merchant** — cualquier merchant con API key válida podía modificar o borrar transacciones ajenas (mismo patrón que el bug de `ensureTx` del 16 jul, en otro router); el listado y las analíticas además agregaban TODOS los merchants; (2) `POST /transactions/card-payment` aceptaba el **PAN en crudo** en el body (rule engine V1 + acquirers mock); (3) `POST /tokens` aceptaba PAN+CVV y **guardaba el PAN cifrado en MongoDB** (bóveda propia = scope SAQ D); solo lo frenaba que `TOKEN_API_KEY` no existe en Render → 403 permanente, es decir, a una variable de entorno de activarse; (4) `/initialize` y `/payment-requests`: stack pre-Hosted-Checkout sin ningún consumidor (verificado: ni el front ni los flujos actuales los llaman). | **Retirados los cuatro** (commit `a7bad5e`): `/initialize`, `/tokens` y `/payment-requests` desmontados y eliminados con toda su cadena (16 archivos); `/transactions` reescrito **solo-lectura** con scoping obligatorio por `req.merchantId` en listado, detalle y las cuatro analíticas. La escritura de transacciones ocurre únicamente en los flujos de pago reales. Verificado por tanda: grafo de requires + arranque de la app + suite 119/128. Refuerza la lección del 16 jul: lo montado y olvidado es peor que lo muerto. |

---

## 5. Gaps actuales y deuda técnica

| Gap | Prioridad | Descripción |
|---|---|---|
| ~~Capture/cancel endpoints incorrectos~~ | ✅ RESUELTO Y VERIFICADO — sesión julio 2026 | Verificado con la doc oficial de Paylands (docs.paylands.com/en/reference): capture real es `POST /payment/confirmation` (no `/payment/capture`) y cancel real es `POST /payment/cancellation` (no `/payment/cancel`). **Hallazgo clave**: ambos endpoints SOLO operan sobre órdenes creadas con `operative: "DEFERRED"` — con `AUTHORIZATION` (lo que usábamos) el dinero se mueve al instante y no hay nada que confirmar/cancelar. Cambiado `operative` a `DEFERRED` en `createOrder`/`createOrder3DS`/`chargeWithToken`. **Segundo hallazgo**: una orden DEFERRED autorizada devuelve `PENDING_CONFIRMATION` (no `SUCCESS`) en el webhook — añadido al `STATUS_MAP` → `authorized`. **VERIFICADO end-to-end** (16 jul): tx nueva DEFERRED → webhook `PENDING_CONFIRMATION` → `authorized` en local → `POST /payments/{id}/capture` → `200 captured` con importe correcto. **Cancel también VERIFICADO** (16 jul): tx nueva DEFERRED autorizada sin capturar → `POST /payments/{id}/cancel` → `200 canceled`. Los tres flujos (refund total/parcial, capture, cancel) confirmados funcionando contra Paylands real. Nota operativa: durante la depuración, varios "fallos" se debieron a que las pruebas se hacían antes de que Render terminara el deploy — SIEMPRE confirmar que el deploy está Live antes de probar. |
| **S2S no cumple el objetivo "Monetiser nunca toca el PAN"** | **✅ RESUELTO EN CÓDIGO (18 jul 2026)** · validación SAQ formal → M5 | `POST /:merchantId/payments/server` acepta `cardPaymentMethodSpecificInput.card.cardNumber` en crudo en el body — a diferencia de Hosted Checkout (ProxyFields), aquí el PAN sí transita por la API de Monetiser. Además, **`payNoPainConnector.js` no tiene función `authorize()`** — solo `createOrder`/`createOrder3DS` (estilo Hosted, con redirect) y `chargeWithToken`. Como la política por defecto de cualquier merchant sin reglas custom es `defaultConnector: 'dummyCard'`, el S2S "funciona" hoy solo contra el conector de mentira; si una regla llegase a enrutar S2S hacia `payNoPain` reventaría con `connector.authorize is not a function`. **Corrección (16 jul 2026):** este párrafo afirmaba que "el PAN no se loguea en ningún punto del código". Era **falso**: se comprobaron `Transaction`, `auditLogger`, `PaymentAttempt` y `payNoPainConnector.js` (esos sí estaban limpios), pero NO se revisaron `proxyPciRoutes.js` ni `pciProxyService.js`, que sí lo logueaban. Corregido — ver la fila "Logs de debug en producción". Hoy sí es cierto: el PAN no llega a ningún logger. Aun así, aceptar el PAN en el body de la API ya pone a Monetiser en un scope PCI distinto (no SAQ A) para ese flujo concreto, y es incompatible con el objetivo declarado del proyecto. **DECISIÓN TOMADA (16 jul 2026, Marcos): OPCIÓN A — S2S solo aceptará tokens ya generados vía ProxyFields. Nunca PAN en crudo. Monetiser se mantiene en scope SAQ A.** Motivo: SAQ D (auditoría QSA externa, escaneos ASV trimestrales, pentest anual) no es asumible hoy; y el scope solo se abre en un sentido — en cuanto el PAN pasa por producción una vez, SAQ D aplica y no se vuelve atrás. Si en el futuro un merchant grande exige S2S con PAN y hay presupuesto para SAQ D, se añade entonces. **Implicaciones pendientes de implementar (NO hecho aún):** (1) rechazar `card.cardNumber` en el endpoint S2S y aceptar solo token/cardUuid; (2) escribir `authorize()` en `payNoPainConnector.js` reaprovechando `chargeWithToken` (hoy no existe — S2S solo funciona contra `dummyCard`). Alternativa contemplada y no descartada: retirar el endpoint S2S hasta que un merchant lo pida (nadie lo usa hoy). **Mientras tanto: NO usar S2S con tarjetas reales ni de test** — usar Hosted Checkout para generar transacciones de prueba contra PayNoPain real. En OpenAPI (M4) S2S se documenta como EXPERIMENTAL, nunca como estable. **RATIFICADO (18 jul 2026, Marcos):** decisión A confirmada tras discutir el matiz PCI. Matiz registrado: SAQ A es formalmente el cuestionario que rellenan los *merchants*; lo que tokens-only garantiza es (a) que cada merchant de Monetiser pueda acogerse a SAQ A (externaliza todo el manejo de tarjeta a Monetiser→Paylands — argumento de venta) y (b) scope PCI mínimo de Monetiser como proveedor de servicio, al no existir datos de tarjeta en su entorno. Qué validación formal corresponde a Monetiser como proveedor lo determinarán PayNoPain y en su caso un QSA — se documenta en M5, sin prometer certezas regulatorias. **Implementación programada para la próxima sesión:** (1) endpoint S2S rechaza `cardNumber` con error claro y acepta solo `source_uuid`/token de ProxyFields; (2) `authorize()` en `payNoPainConnector.js` sobre `chargeWithToken` (ya en DEFERRED); (3) tests. Último bloqueante técnico antes de M5. **✅ IMPLEMENTADO EN CÓDIGO (18 jul 2026):** los tres puntos hechos. (1) `serverPaymentController.js` rechaza `cardNumber`/`cvv` en crudo con `400 card_data_not_accepted` (mensaje explícito de SAQ A) ANTES de validar estructura, y exige el token en el campo raíz `source_uuid` o en `cardPaymentMethodSpecificInput.token` (`400 missing_card_token` si falta); ya no construye `paymentData` con PAN, pasa `cardToken`. (2) `authorize(paymentData)` añadido y exportado en `payNoPainConnector.js`: exige `cardToken`, reutiliza `chargeWithToken` (DEFERRED, envía el token como `source_uuid`), y normaliza la respuesta a `requires3DS`/`approved`/`declined`. De paso: `connectorRegistry.adaptPayNoPain` propaga `requires3DS`/`threeDsUrl`, y `paymentService.processCardPayment` reconoce `requires3DS` como estado `pending_3ds` propio (no un decline, sin fallback), que el controller convierte en `merchantAction: REDIRECT` a la URL 3DS. (3) tests: `serverPayment.test.js` reescrito a tokens-only (rechazo de PAN, token en ambas grafías, falta de token, propagación de `pending_3ds`) + nuevo `tests/unit/payNoPainAuthorize.test.js` (existencia de `authorize`, `missing_card_token` sin red, `requires3DS` verificando que envía `source_uuid` + `operative: DEFERRED`, y `declined` en no-200). Verificado con el protocolo de CLAUDE.md: arranque de la app (grafo de requires limpio) + suite **128/137** — misma línea base (los 9 fallos siguen siendo los preexistentes de `webhooks.test.js`), +9 tests nuevos verdes. Documentado en `openapi.yaml` v2.1.0: S2S deja de ser `experimental`/`deprecated` y pasa a `beta` (contrato cerrado, **aún sin verificar end-to-end contra Paylands real** — por eso `beta` y no `estable`). **Lo que NO cambia:** la validación PCI formal de Monetiser como proveedor sigue siendo trabajo de M5 (lo determinan PayNoPain y/o un QSA); esto cierra el bloqueante de *código*, no promete certezas regulatorias. **Pendiente antes de subir a `estable`:** una prueba real S2S→payNoPain contra Paylands sandbox (hoy no ejecutada). |
| ~~Modelo Merchant en MongoDB~~ | ✅ M2 COMPLETADO | Modelo `Merchant` unificado con campos operativos (plan, status, webhookUrl, signingSecret, serviceUuid, templateUuid, branding). Rutas `/merchants` montadas y protegidas por X-Admin-Token. Dispatcher firma por-merchant. Detalle completo en sección 6 (M2). |
| ~~Panel de administración `/admin`~~ | ✅ M3 COMPLETADO | Dashboard con analíticas, transacciones (refund/cancel/widgets expandibles), usuarios, merchants, API keys y motor de reglas. Ver sección 6 (M3). |
| ~~Capture/cancel Paylands sin verificar~~ | ✅ RESUELTO — 16 jul 2026 | Fila obsoleta, se mantenía por error contradiciendo la fila de arriba. Capture y cancel están VERIFICADOS end-to-end contra Paylands real (ver fila 1 y sección 11). |
| ~~Flags FEATURE_RULE_* sin confirmar en Render~~ | ✅ **RESUELTO — 16 jul 2026** | **CONFIRMADO POR MARCOS: los tres (`FEATURE_RULE_TRY`, `FEATURE_RULE_AUDIT`, `FEATURE_RULE_EXPORT_UI`) están a `1` en Render.** Ya no hay nada pendiente aquí. Los botones Probar / Histórico / Exportar / Importar de la pestaña Reglas están operativos, y la auditoría de cambios de política **sí se está escribiendo** (era lo que preocupaba: con `FEATURE_RULE_AUDIT` apagado los cambios se guardan sin autor). Documentación de qué hace cada flag en sección 8 → "Flags de la pestaña Reglas". |
| Editor de reglas viejo (`/admin/index.html` + `app.js`) | Baja | Redundante desde que existe la pestaña Reglas del dashboard nuevo (mismo backend). Sigue ahí sin usarse ni eliminarse — decisión de Marcos si lo retira. |
| ~~OpenAPI completa~~ | ✅ M4 COMPLETADO — 16 jul 2026 | `openapi.yaml` en la raíz (3.1, v1.0.0): 23 rutas, 27 operaciones, 21 schemas, 4 webhooks salientes, 0 refs rotas. Una sola spec: la antigua `openapi/monetiser.yaml` eliminada y su contenido portado (nada la referenciaba). Ver sección 6 (M4). |
| ~~**Webhooks salientes: DOS emisores con firmas incompatibles**~~ | ✅ **RESUELTO — 17 jul 2026** | **Unificado: `sendWebhookIfAny()` (paymentsController) delega ahora en `webhookDispatcher.enqueue()`.** Un único contrato para TODOS los webhooks salientes: header `Monetiser-Signature: t=<ts>, v1=<hex>`, secreto por-merchant con fallback a `WEBHOOK_SECRET`, reintentos con backoff y registro en `webhooklogs`. De propina: el evento `payment.canceled` pasó a `payment.cancelled` (grafía Paylands, cerrando el "pendiente cosmético" de la fila siguiente) y su flag `data.canceled`→`data.cancelled`. Cambio de contrato asumible: no hay merchants integrados. Documentado en `openapi.yaml` v2.0.0. **Descripción original del problema:** Descubierto al escribir el OpenAPI (M4). **Eran tres; el tercero (`src/core/webhookService.js`, vía `/apms`) desapareció al retirar ese stack** — ver sección 4. Quedan dos, y siguen siendo incompatibles entre sí. **No depende del entorno**: los nombres de cabecera son literales escritos a fuego, sin ningún `if` sobre `NODE_ENV`/`PAYNOPAIN_ENV`; en producción pasaría igual. <br><br>**(1) `src/services/webhookDispatcher.js`** — evento `payment.updated`. Usado por `routes/webhooks.js` y `transactionController.js`. Header `Monetiser-Signature: t=<ts>, v1=<hex>` (CON espacio tras la coma). Secreto: `signingSecret` del merchant → fallback `WEBHOOK_SECRET`. Reintentos con backoff. Registro en `webhooklogs`. <br>**(2) `sendWebhookIfAny()` en `src/controllers/paymentsController.js`** — eventos `payment.captured`/`refunded`/`canceled`. Header **`x-monetiser-signature: t=<ts>,v1=<hex>`** (nombre DISTINTO, SIN espacio) + `x-monetiser-timestamp`. Secreto: **solo `WEBHOOK_SECRET` global** (ignora el del merchant). **Sin reintentos. Sin registro** (fallo = un `warn`). <br><br>**Consecuencias reales:** (a) un merchant que verifique `Monetiser-Signature` fallará **en silencio** los eventos de ciclo de vida, que van por `x-monetiser-signature`; (b) si el merchant tiene `signingSecret` propio y no hay `WEBHOOK_SECRET` global, el emisor 2 envía **sin firmar** — no se omite, sale igual sin el header; (c) contradice lo que este DEV-LOG afirma de M2 Fase C ("el dispatcher firma por-merchant"): cierto solo para 1 de los 2. <br><br>Hoy no ha explotado solo porque no hay ningún merchant real verificando firmas. **Documentado tal cual en `openapi.yaml`. Pendiente de decidir:** que `sendWebhookIfAny` use `webhookDispatcher.enqueue()` (gana secreto por-merchant, reintentos y registro gratis, y queda una sola firma). Es cambio de contrato de cara al merchant — momento barato de hacerlo, precisamente por estar en test y sin nadie integrado. |
| ~~**`canceled` vs `cancelled`**~~ | ✅ **RESUELTO — 16 jul 2026** (`3153984`) | **Arreglado alineando a `cancelled` (dos L), que es la grafía de Paylands** — criterio marcado por Marcos y verificado en su contrato: endpoint `POST /payment/cancellation` y status de webhook `CANCELLED`/`USER_CANCELLED`, ambos con dos L. Dos cambios, no uno: (1) `paymentsController.js:532` `'canceled'`→`'cancelled'`; (2) `dashboard.js:525`, el desplegable de filtro por estado ofrecía `value="canceled"` — **ese filtro ya estaba roto antes**: no encontraba las tx canceladas desde el propio dashboard (que se guardan con dos L), solo las de la API. **Cambio de contrato:** `POST /payments/{id}/cancel` ahora responde `{"status":"cancelled"}`. Aceptable: no hay merchants integrados. **Datos existentes:** las tx de prueba con `canceled` se quedan así y seguirán dando `completed:false`; son de test, no se migró nada. **Pendiente cosmético — CERRADO 17 jul 2026:** el evento saliente ya se llama `payment.cancelled` (dos L), alineado al unificar los emisores de webhook. Descripción original del bug abajo. |
| *(histórico del bug anterior)* | *resuelto* | Descubierto verificando el deploy del 16 jul 2026. **Coexisten las dos grafías y no las escribe el mismo sitio:** `POST /payments/{id}/cancel` guarda `canceled` (una `l`, `paymentsController.js:532`); el botón Cancelar del dashboard guarda `cancelled` (dos `l`, `backofficeRoutes.js:303`); y el webhook de Paylands mapea `CANCELLED` → `cancelled` (dos `l`, `webhooks.js:129`). Cuando se cancela por API, el webhook escribe `cancelled` y ~100 ms después el controlador lo **pisa** con `canceled`. **Consecuencia:** `hostedCheckoutController.js:260` calcula `completed` con `['approved','authorized','declined','refused','cancelled'].includes(tx.status)` — solo la grafía de dos `l`. Un pago cancelado por API devuelve **`completed: false` para siempre**; un merchant que sondee el estado, sondea eternamente. **EVIDENCIA REAL** (tx `a0408ee0-ba65-4dc7-bccb-6c3a778f8c83`, la que se verificó el 16 jul): en Mongo figura `"status":"canceled"` con `"lastWebhookRaw":{"status":"CANCELLED"}`, y su endpoint de status devuelve `{"status":"canceled","completed":false}`. El `cancel` está correctamente ejecutado contra Paylands — lo que falla es cómo queda registrado. Nota: `Transaction.status` es `{type:String, required:true}` **sin `enum`**, así que Mongoose no detecta la divergencia. **Arreglo propuesto (1 carácter, pendiente de decisión de Marcos):** `paymentsController.js:532` → `'cancelled'`. Cambia la respuesta documentada de `/cancel` (hoy `canceled`) y habría que revisar las tx ya guardadas con la grafía vieja. Ya arreglado — ver fila de arriba. |
| Contrato inconsistente capture vs refund | Media | `captureSchema` usa `amount` plano (entero, céntimos); `refundSchema` y `cancelSchema` usan `amountOfMoney: { amount, currencyCode }`. Mismo concepto, dos formas, en endpoints hermanos. Documentado tal cual en `openapi.yaml`. No rompe nada hoy (lo verificado fue con body vacío) pero confundirá a quien integre. |
| `x-api-key` transporta el keyId, no el secreto | Media | En modo simple (`API_KEY_SIMPLE_FALLBACK=true`), `validateApiKey()` busca por `keyId: rawKey` — es decir, el header lleva el `rawKeyId` (`mk_...`) y **el `rawSecret` no interviene**: el identificador actúa como credencial. Aceptable para Postman, no para producción. Es el motivo de que exista el modo HMAC. Documentado en `openapi.yaml` (securityScheme `ApiKeySimple`). |
| La firma HMAC usa `secretHash`, no el secreto | Baja — solo documentación | `hmacAuth.js` hace `computeSignature(doc.secretHash, stringToHash)`: la clave del HMAC es el SHA-256 del secreto, no el `rawSecret`. Quien integre debe hashear su secreto antes. No es un fallo, pero es contraintuitivo y no estaba escrito en ningún sitio. Ya documentado en `openapi.yaml`. |
| test-checkout.html no carga con iframe | Baja | El botón "Cargar" no funciona — workaround: abrir la URL directamente en el navegador |
| ~~Logs de debug en producción~~ | ✅ RESUELTO — 16 jul 2026 | **La deuda descrita aquí no era la real.** `fullBody` NO existía en ninguna parte del repo (era deuda fantasma: se limpió en algún momento y nadie actualizó este documento), y `tokenKeys` tenía UNA sola ocurrencia, no varias. `serverPaymentController.js` y `payNoPainConnector.js` no tenían nada que limpiar. **Lo que sí había y no estaba apuntado: el PAN se logueaba en dos sitios** — `proxyPciRoutes.js` (PROXY_PCI_TOKEN_RETRIEVED) y `pciProxyService.js` (PCI_PROXY_GET_RESULTS_OK). No llegó a filtrarse porque `sanitizeData()` de `logger.js` redacta por regex las claves con "pan" (el valor salía como `[REDACTED]`, por lo que quitarlos no perdió información), pero para SAQ A el PAN no debe llegar al logger y depender de un regex. Eliminados también `tokenKeys` y `tokenValue` (30 chars del token de tarjeta). Se conservan los ids (paymentId, merchantId, cardUuid, reference, brand). El sanitizador queda como red de seguridad, no como primera línea. |
| WEBHOOK_SECRET | Media | Ya NO es bloqueante: desde M2 Fase C el dispatcher firma con el `signingSecret` del merchant y solo usa `WEBHOOK_SECRET` como fallback global. Conviene configurarlo igualmente para merchants sin secreto propio. |
| Suite de tests no verde en algunos entornos | Media | `npx jest` → **238/247 pasan** (119/128 M4, 128/137 S2S, 160/169 M6 F1, 182/191 M6 F2, 200/209 M6 F3+F4, 212/221 M7 F1, 221/230 M7 F2, 225/234 M7 B1). Los 9 fallos están en `tests/integration/webhooks.test.js` y son PREEXISTENTES (no los introdujo M2/M6): la suite necesita MongoDB en memoria / config de entorno que no siempre está. Verificado clonando el código original. `supertest` es devDependency y debe estar instalada para correr las suites de integración. **Nota M6:** los tests del portal (usuarios y jerarquía) NO usan mongodb-memory-server (no disponible); usan un modelo en memoria propio (`tests/helpers/memoryModel.js`) y por eso sí corren en verde en este entorno. |

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
  del repo. **→ REACTIVADO Y REDISEÑADO en M6 Fase 2 (20 jul 2026):** el modelo plano
  se retiró y la jerarquía se rehízo como árbol por-tenant (`HierarchyNode`). Ver M6.
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
  cuál, y por qué `FEATURE_RULE_AUDIT` es el crítico). **CONFIRMADO por Marcos (16 jul
  2026): los tres están a `1` en Render**, así que los cuatro botones funcionan y la
  auditoría se escribe. `getPolicy`/`upsertPolicy` (cargar/guardar, lo esencial) NO
  dependen de ningún flag, siempre funcionan.
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
*(Estado a 16 jul. Actualizado el 18 jul: al implementar S2S tokens-only, ese
endpoint pasó de `experimental`+`deprecated` a `beta` en `openapi.yaml` v2.1.0 —
ver la fila S2S de la sección 5 y la nota de sesión del 18 jul.)*

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

### M6 — Gestión multi-tenant de usuarios de merchant y portal

**Alcance definido por Marcos (20 jul 2026):** el onboarding es SIEMPRE operado por
Monetiser — el cliente NO se autorregistra. El superadmin interno crea el merchant
(M3) y su primer usuario; el `merchant_admin` gestiona a los suyos. **Fuera de
alcance en M6:** el aprovisionamiento del *service* en Paylands (depende de la
decisión agregador-vs-cuenta-por-merchant, aplazada), M7 billing y el envío de emails.

> **Sobre la nota "no empezar M6 sin la decisión agregador vs cuenta-por-merchant"**
> (sesión 18 jul): esa decisión bloquea el *aprovisionamiento en Paylands* del
> onboarding, que aquí queda FUERA de alcance. La gestión de usuarios/tenant y el
> portal (lo de M6) no dependen de ella. Resurgirá cuando el onboarding toque el
> alta del service en Paylands (fase futura).

**Plan de fases:** Fase 1 = modelo de usuarios + auth del portal + CRUD de usuarios
por el merchant_admin + aislamiento con tests (hecho). Después: Fase 2 jerarquía de
tiendas, Fase 3 portal visual, Fase 4 permisos por nodo.

**Decisiones de arquitectura (ratificadas por Marcos):**
- **Modelo nuevo `MerchantUser`**, colección propia SEPARADA de `BackofficeUser`
  (no extender). Colecciones distintas = una query del plano merchant nunca puede
  devolver un usuario interno, ni con un filtro con bug. Garantía dura de "un
  merchant_admin jamás toca usuarios internos".
- **Portal con superficie separada** (`/portal/*` + SPA propia en fases posteriores),
  no reutilizar la SPA de admin con gates. La SPA de admin habla con `/backoffice/*`
  (cross-merchant); reutilizarla metería código cross-merchant en el navegador del
  merchant. Los gates de cliente no son seguridad — el aislamiento va en servidor.

#### M6 Fase 1 ✅ COMPLETADO (20 jul 2026) — backend, sin UI

**Modelo y planos separados:**
- `src/models/MerchantUser.js`: `merchantId` (inmutable), `email` (único en el plano
  merchant), `role` (enum fijo v1: `merchant_admin`/`merchant_operator`/`merchant_viewer`),
  `active`, `mustChangePassword`, y campo-puente `hierarchyNodeId` dormido (Fase 4,
  mismo patrón que `Merchant.hierarchyId`).

**Auth del portal (plano separado del backoffice):**
- `src/middleware/portalAuth.js`: JWT propio con `PORTAL_JWT_SECRET` + `audience: portal`.
  Un token de backoffice se rechaza aquí (sin aud), y uno de portal se rechaza en el
  backoffice **si los secretos son distintos** → `PORTAL_JWT_SECRET` DEBE ser ≠
  `BACKOFFICE_JWT_SECRET` en producción (es lo que impide que un token de merchant sea
  aceptado en el backoffice). `requirePortalRole`, `requirePasswordChanged`.
- `src/middleware/rateLimiterPortalLogin.js`: rate limit del login por IP+email
  (requisito duro). `RL_PORTAL_LOGIN_MAX` (10) / `RL_PORTAL_LOGIN_WINDOW_MS` (15 min).
- `src/routes/portalAuthRoutes.js`: `POST /portal/auth/login` (rate-limited) y
  `POST /portal/auth/change-password`. Password temporal + cambio obligatorio en el
  primer login (sin infra de email): mientras `mustChangePassword`, el portal bloquea
  todo salvo el cambio de password (`403 password_change_required`).

**CRUD scoped a la sesión** (`src/routes/portalRoutes.js`):
- `GET /portal/me`, `GET /portal/users`, `POST /portal/users`, `PATCH /portal/users/:userId`.
  Escrituras solo `merchant_admin`. **AISLAMIENTO:** el `merchantId` sale SIEMPRE de
  `req.portalUser.merchantId` (la sesión), nunca del cliente. Todo recurso se resuelve
  con ese `merchantId` en el filtro → un usuario de otro merchant no existe para la
  sesión (**404**, no revela existencia). Es la lección del bug cross-tenant del §4:
  no se repite. Proyección pública explícita (`src/utils/publicUser.js`): nunca se hace
  spread del doc, el `passwordHash` no puede escaparse. Sin auto-lockout (un admin no
  se degrada ni desactiva a sí mismo).

**Siembra por el plano interno** (`src/routes/backofficeRoutes.js`):
- `GET/POST /backoffice/merchants/:merchantId/portal-users` (solo `superadmin`) para
  crear el primer `merchant_admin`. Devuelve la password temporal UNA sola vez (patrón
  del rawSecret de las API keys). Aquí el `:merchantId` del param es LEGÍTIMO — el
  superadmin tiene visibilidad global por diseño; la regla "merchantId solo de la
  sesión" aplica al plano `/portal`, no a este.

**Tests (32 nuevos, todos verdes):** `tests/integration/portalAuth.test.js`,
`portalUsers.test.js`, `portalIsolation.test.js`, `portalRateLimit.test.js` +
helper `tests/helpers/memoryModel.js` (modelo en memoria; no hay mongodb-memory-server).
Cubren: login + password temporal, CRUD + gates de rol, aislamiento A↔B (404 cross-tenant,
merchantId falsificado ignorado, separación criptográfica de planos, bloqueo por
mustChangePassword) y rate limit 429. **Protocolo CLAUDE.md verificado:** app arranca con
grafo de requires limpio + suite **160/169** (misma línea base — los 9 fallos siguen siendo
los preexistentes de webhooks.test.js).

**Documentado en `openapi.yaml` v2.2.0:** tag `Portal`, security scheme `PortalBearer`,
5 rutas `/portal/*` y 7 schemas.

#### M6 Fase 2 ✅ COMPLETADO (20 jul 2026) — jerarquía de tiendas por tenant

**Reactivada la jerarquía que estaba en standby, pero REHECHA como árbol por-tenant.**
El modelo viejo (`MerchantHierarchy`) era un registro PLANO por tienda (niveles como
strings, `merchantId` = id de tienda único global) — no un árbol, y confundía "tenant"
con "tienda hoja" bajo el mismo nombre `merchantId`. Verificado que NINGÚN código lo
requería (solo dos punteros dormidos en `Merchant`/`MerchantUser`): reactivar = rediseñar
sin romper nada vivo.

- `src/models/HierarchyNode.js`: árbol con lista de adyacencia. `merchantId` = TENANT
  dueño (inmutable, coherente con todo el sistema), `nodeType`
  (globalGroup/group/branch/region/store), `parentId` (null = raíz). **Colección NUEVA
  `hierarchynodes`** (distinta de la vieja `merchanthierarchies`) para no colisionar con
  datos/índices heredados si existieran en la BD — no comprobable desde aquí, así que se
  neutraliza por diseño.
- `src/utils/hierarchyLevels.js`: `NODE_TYPES` + `RANK`. El padre debe ser de nivel
  estrictamente superior (se permite saltar niveles); esa regla hace además IMPOSIBLE
  un ciclo.
- `MerchantHierarchy.js` **retirado**; `Merchant.hierarchyId` y `MerchantUser.hierarchyNodeId`
  pasan a `ref: 'HierarchyNode'`. `Merchant.hierarchyId` queda como puntero opcional al
  nodo raíz.
- `src/routes/portalHierarchyRoutes.js` (`/portal/hierarchy`): GET (lectura para cualquier
  usuario del portal), POST/PATCH/DELETE (solo `merchant_admin`). **Aislamiento:** `merchantId`
  siempre de la sesión; nodo de otro merchant → 404; `parentId` a otro tenant → 404
  `parent_not_found` (no se puede colgar el árbol propio de otro tenant). DELETE rechaza
  nodos con hijos (409). **V1 = estructura**; asignar usuarios a nodos es Fase 4 (puente
  `hierarchyNodeId`, dormido).

**Tests (22 nuevos, todos verdes):** `tests/integration/portalHierarchy.test.js` — CRUD +
reglas de nivel del árbol, gates por rol, y AISLAMIENTO (A no ve/edita/borra nodos de B,
no puede colgar de un nodo de B, merchantId del body ignorado). **Protocolo CLAUDE.md:**
app arranca con grafo de requires limpio (el modelo borrado no rompe nada, la ruta nueva
monta) + suite **182/191** (misma línea base — los 9 fallos preexistentes de webhooks.test.js).
Documentado en `openapi.yaml` v2.3.0 (rutas `/portal/hierarchy` + 3 schemas).

#### M6 Fase 3 ✅ COMPLETADO (20 jul 2026) — datos read-only + portal visual

**Backend (datos del portal, solo lectura, scoped a la sesión):**
- `GET /portal/transactions` (paginado + filtros status/method/fecha/`q`),
  `GET /portal/transactions/:paymentId`, `GET /portal/analytics/summary` (KPIs:
  total, aprobadas, rechazadas, tasa de aprobación, volumen y ticket medio en
  céntimos). Todo filtra por `req.portalUser.merchantId`; una transacción de otro
  merchant → 404. Lectura para cualquier rol. Añadidos en `portalRoutes.js`.

**Frontend (SPA separada):**
- `public/portal/index.html` + `app.js` (vanilla, sin dependencias), servida en
  `/portal-app` (montaje en `index.js`, separada del namespace autenticado
  `/portal/*`). Habla EXCLUSIVAMENTE con `/portal/*`; los gates de rol del cliente
  son solo UX, el aislamiento es de servidor. Flujo: login → cambio obligatorio de
  password → dashboard con pestañas Resumen / Transacciones / Usuarios (admin) /
  Jerarquía (admin).

#### M6 Fase 4 ✅ COMPLETADO (20 jul 2026) — permisos por nodo

- El JWT del portal lleva ahora `hierarchyNodeId` (portalAuth lo inyecta en
  `req.portalUser`). Un `merchant_admin` asigna/desasigna con
  `PATCH /portal/users/:id { hierarchyNodeId }` (el nodo debe ser del propio
  merchant → si no, `400 invalid_hierarchy_node`).
- Scoping por subárbol en `/portal/hierarchy`: un usuario asignado a un nodo solo
  VE su subárbol (GET) y solo crea/edita/borra DENTRO de él; fuera, los nodos "no
  existen" (404) y no puede crear/mover ahí (`403 outside_your_scope`). Se aplica
  ENCIMA del aislamiento por merchant, no en su lugar. Sin asignación (null) ve
  todo su merchant.
- **Limitación documentada:** las transacciones no llevan referencia de nodo
  todavía, así que el scoping por nodo aplica a la JERARQUÍA; la visibilidad de
  transacciones sigue siendo a nivel de merchant. Mejora futura: etiquetar
  transacciones con un nodo.

**Tests (Fases 3+4): 18 nuevos verdes** (`portalData.test.js`, `portalNodePerms.test.js`).
Suite **200/209** (misma línea base). `openapi.yaml` v2.4.0 (rutas de datos + node
scoping + 2 schemas). **M6 COMPLETO** (Fases 1-4). Decisión operativa de Marcos
(20 jul): a partir de aquí **todo el desarrollo va en `main`** (sin ramas nuevas);
la rama de M6 se fusionó a `main`.

### Onboarding — aprovisionamiento en Paylands (fase futura, fuera de M6)
- Alta del `service` por merchant en Paylands. Bloqueado por la decisión
  agregador-vs-cuenta-por-merchant (aplazada, con implicaciones PSD2).

### M7 — Billing

**Fase 1 ✅ COMPLETADO (20 jul 2026) — medición y cálculo (sin cobro real).**
- **Modelo de precios FLEXIBLE** (`src/utils/pricingDefaults.js` + `src/models/PricingPlan.js`):
  tres dimensiones combinables en céntimos — cuota mensual (`monthlyBase`) + fee por
  transacción facturable (`perTransactionFee`) + % de volumen (`volumeBps`). Una fila
  por plan; si no existe, se usan placeholders. **Marcos edita los precios sin desplegar**
  (`PUT /backoffice/pricing/:plan`). **En Fase 1 NO se mueve dinero real.**
- **Cálculo** (`src/services/billingService.js`): `computeBilling(merchantId, period, pricing)`
  agrega las transacciones FACTURABLES (`approved`/`authorized`/`captured`) del mes y aplica
  las tres dimensiones. Las declinadas/canceladas/reembolsadas NO se facturan en v1.
- **Endpoints:** portal `GET /portal/billing` (mes actual + historial 6 meses) y
  `GET /portal/billing/:period` — solo `merchant_admin`, **scoped a la sesión** (cada
  merchant ve solo SU factura). Backoffice (superadmin): `GET/PUT /backoffice/pricing[/:plan]`
  y `GET /backoffice/billing?period=` (todos los merchants + gran total).
- **Portal visual:** pestaña **"Facturación"** (admin) con el desglose del mes + historial.
- **Tests: 12 nuevos verdes** (`billingService.test.js`, `portalBilling.test.js`) — cálculo,
  exclusión de otro período/merchant, aislamiento A/B, gate por rol. Suite **212/221**
  (misma línea base). `openapi.yaml` v2.5.0.
- **Decisión pendiente para Fase 1→producción:** los precios por defecto son PLACEHOLDERS;
  Marcos pone los reales. Rol: la facturación del portal es solo `merchant_admin` (info de
  cuenta) — ajustable si se quiere abrir a viewer.

**Fase 2 ✅ COMPLETADO (20 jul 2026) — cierre/finalización de facturas.**
- `src/models/BillingRecord.js`: una factura por (merchantId, período), con nº de
  factura (`INV-YYYY-MM-merchantId`), **snapshot de precios aplicados** y cifras
  congeladas. `status` finalized/paid ('paid' se usará en Fase 3).
- `billingService.finalizeBilling()`: **idempotente** (si ya existe la devuelve sin
  recalcular) y **solo sobre períodos CERRADOS** (rechaza el mes en curso o futuro con
  `period_not_closed`). Una factura finalizada es INMUTABLE aunque cambien transacciones
  antiguas. `getFinalized`, `listInvoices`, `isPeriodClosed`.
- Portal: `GET /portal/invoices` (facturas emitidas del propio merchant) y
  `GET /portal/billing/:period` devuelve la factura congelada si está finalizada
  (`finalized:true`), si no un borrador vivo. Pestaña "Facturación": sección "Facturas
  emitidas" + **factura imprimible** (window.print → guardar PDF).
- Backoffice (superadmin): `POST /backoffice/billing/:merchantId/finalize` y
  `POST /backoffice/billing/finalize` (todos los merchants de un período), + el listado
  marca `finalized` por merchant.
- **Tests: 9 nuevos verdes** (`billingFinalize.test.js`, `portalInvoices.test.js`) —
  idempotencia, guarda de período no cerrado, inmutabilidad, aislamiento de facturas.
  Suite **221/230**. `openapi.yaml` v2.6.0 (rutas + schema `Invoice`).

**Bloque 1 ✅ COMPLETADO (20 jul 2026) — facturación real (sustituye la idea de Stripe).**
Decisión de Marcos: **nada de pasarela de cobro** (Stripe/Paddle). Monetiser **emite la
factura** (solo LO NUESTRO: pasarela + servicios; la adquirencia es informativa — capa
tecnológica, no payfac), la carga en el perfil del merchant, la envía por email y vosotros
la descargáis para el ERP. **Sociedad en Canarias ⇒ IGIC (no IVA).**
- **Emisor** (`CompanyProfile`, singleton): NIF, dirección, serie de factura, IGIC, IBAN,
  logo, pie. `GET/PUT /backoffice/company`.
- **Impuestos** (`TaxRate` + defaults IGIC 0/3/7/9,5/15%, no sujeto, ISP, exento):
  `GET /backoffice/tax`, `PUT /backoffice/tax/:code`. Por defecto IGIC general 7% (clientes
  de Canarias); NO_SUJETO/ISP para Península/UE con mención legal impresa.
- **Contrato por merchant** (`MerchantContract`): rate-card (mantenimiento, fee/tx, volumen,
  precio/usuario + incluidos, servicios/módulos) + datos fiscales del receptor + tipo de
  IGIC. `GET/PUT /backoffice/merchants/:id/contract`. El billing usa el contrato si existe;
  si no, cae a la tarifa por plan. El merchant ve su tarifa en `GET /portal/contract`.
- **Factura oficial**: numeración correlativa por serie+año (`InvoiceCounter`, `$inc` atómico,
  sin huecos), snapshots inmutables de emisor/receptor, IGIC aplicado, **PDF** (`pdfkit`).
- **Distribución**: email vía **SMTP de Google Workspace** (`nodemailer`, vars `SMTP_*`;
  sin config hace no-op). Portal: `GET /portal/invoices/:id/pdf`. Backoffice: PDF, enviar
  email (`POST /invoices/:id/send`), **facturación mensual** (`POST /billing/run` finaliza
  y opcionalmente envía todos los de un mes cerrado) y **export CSV** para el ERP
  (`GET /billing/export`).
- **Deps nuevas**: `pdfkit` + `nodemailer` (node_modules se versiona en este repo — sin
  `.gitignore`). **Tests nuevos verdes**; suite **225/234**. `openapi.yaml` v2.7.0.
- **Aviso fiscal**: correcta por construcción, pero la validez legal (campos, **Verifactu/SII**)
  la confirma el asesor. Configurable para adaptarlo.

**Bloque 2 ✅ COMPLETADO (20 jul 2026) — adquirentes + routing multi-adquirente + coste real.**
Multi-adquirente preparado para N (hoy solo Paylands en vivo). **La adquirencia es INFORMATIVA
— no se factura** (Bloque 1 factura solo lo nuestro).
- **Modelos**: `Acquirer` (catálogo global + scheme fees/CSF por tipo de tarjeta que pasa el
  adquirente), `MerchantAcquirer` (ficha por merchant con margen ICH++ negociado —
  markup+fixed, on-us reservado, isDefault/priority), `MerchantRoutingRule` (routing estático:
  BIN routing + criterios en AND), `InterchangeRate` (tablas VISA/MC; defaults EEA consumer con
  topes regulados reales 0,20%/0,30% + placeholders comercial/intl). `cardContext` normaliza
  scheme/cardType/región desde la metadata de Paylands.
- **Servicios**: `acquirerService` (catálogo, fichas, `resolveRouting`: 1ª regla que casa → si
  ninguna, adquirente por defecto). `costService` (coste efectivo = interchange + scheme fees +
  margen adquirente + fee pasarela; media del período — el "número grande" — con **disclaimer**:
  aproximado, lo fijan las marcas).
- **Endpoints**: portal (`merchant_admin`): `GET/PUT/DELETE /portal/acquirers[/:code]`,
  `GET/PUT /portal/routing`, `POST /portal/routing/simulate`, `GET /portal/costs`. Backoffice
  (superadmin): `GET/PUT /backoffice/acquirers[/:code]` (catálogo + CSF), `GET/PUT
  /backoffice/interchange[...]` (tablas VISA/MC). El merchant pone su margen y su routing; el
  superadmin mantiene CSF e interchange.
- **Portal visual**: pestañas **Adquirentes** (fichas + margen + routing + simulador) y
  **Coste real** (el número grande + tasa efectiva + desglose por transacción + disclaimer).
- **Tests (13 nuevos verdes)**: coste, routing, endpoints con aislamiento A/B. Suite **238/247**.
  `openapi.yaml` v2.8.0.
- **Limitación v1 anotada**: el routing a N adquirentes en el flujo de pago VIVO llega cuando
  exista un 2º conector real (hoy Paylands procesa todo); la detección de on-us necesita datos
  que aún no tenemos con fiabilidad (el campo queda listo).

**M7 COMPLETO** (Fases 1-2 + Bloques 1-2). **Pendiente (opcional, futuro):** enganche directo
con el ERP; `status: 'paid'` del BillingRecord reservado para cuando el ERP confirme el cobro;
un 2º conector de adquirente para activar el routing real; base de BINes/interchange más
completa que las tablas de arranque. Limitación de M6 Fase 4 relevante: las transacciones no
llevan referencia de nodo, así que billing y coste son por merchant, no por nodo.

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
| Aislamiento de tenant en el portal | `src/routes/portalRoutes.js`, `src/routes/portalHierarchyRoutes.js` | Todo endpoint filtra por `req.portalUser.merchantId` (sesión), nunca por un merchantId del cliente. Cross-tenant → 404 (incluye usar un `parentId` de jerarquía de otro merchant). |
| Separación criptográfica de planos | `src/middleware/portalAuth.js` | Portal firma con `PORTAL_JWT_SECRET` + aud `portal`; backoffice con `BACKOFFICE_JWT_SECRET`. Deben ser DISTINTOS en prod. |
| Rate limit login del portal | `src/middleware/rateLimiterPortalLogin.js` | Por IP+email. `RL_PORTAL_LOGIN_MAX` (10) / ventana `RL_PORTAL_LOGIN_WINDOW_MS` (15 min). |
| Password temporal + cambio obligatorio | `src/routes/portalAuthRoutes.js` | Alta sin email: temporal visible una vez; `mustChangePassword` bloquea el portal hasta cambiarla. |
| Proyección pública de usuarios | `src/utils/publicUser.js` | Allowlist explícita; el `passwordHash` nunca se serializa en una respuesta. |
| Scoping por nodo (Fase 4) | `src/routes/portalHierarchyRoutes.js` | Un usuario asignado a un nodo (`hierarchyNodeId` en el JWT) solo ve/gestiona su subárbol; fuera → 404 / `403 outside_your_scope`. Encima del aislamiento por merchant. |

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
| `PORTAL_JWT_SECRET` | **(M6)** Secreto de firma del JWT del portal del merchant. **DEBE ser distinto de `BACKOFFICE_JWT_SECRET`** — es lo que impide que un token de merchant sea aceptado en el backoffice. Sin definir usa un fallback de desarrollo (no válido para producción). |
| `BACKOFFICE_JWT_SECRET` | Secreto de firma del JWT del backoffice (dashboard interno). Ya se usaba; sin definir usa fallback de desarrollo. Distinto de `PORTAL_JWT_SECRET`. |

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
| `RL_PORTAL_LOGIN_MAX` | **(M6)** Intentos de login del portal por ventana (default: 10) |
| `RL_PORTAL_LOGIN_WINDOW_MS` | **(M6)** Ventana del rate limit del login del portal (default: 900000 = 15 min) |
| `PORTAL_JWT_EXPIRES` | **(M6)** Caducidad del JWT del portal (default: `12h`) |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` | **(M7 Bloque 1)** SMTP de Google Workspace para enviar facturas (`smtp.gmail.com` / `587` / `false`). Sin configurar, el email hace no-op. |
| `SMTP_USER` / `SMTP_PASS` | **(M7 Bloque 1)** Cuenta de Workspace + contraseña de aplicación. |
| `SMTP_FROM` | **(M7 Bloque 1)** Remitente de los emails (por defecto `SMTP_USER`). |

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

**Estado: ✅ los tres están a `1` en Render** — confirmado por Marcos el 16 jul 2026.
Nada pendiente. La configuración de Render no se toca desde aquí; la gestiona él.

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

### Portal del merchant (M6)

```
POST /portal/auth/login                        → Login del portal (rate-limited) → JWT de portal
POST /portal/auth/change-password              → Cambiar password (limpia mustChangePassword)
GET  /portal/me                                → Datos del usuario de sesión
GET  /portal/users                             → Usuarios del PROPIO merchant (merchant_admin)
POST /portal/users                             → Crear usuario en el PROPIO merchant (merchant_admin)
PATCH /portal/users/:userId                    → Editar nombre/rol/estado (merchant_admin)

GET   /portal/hierarchy                        → Nodos del árbol del PROPIO merchant (scoped por nodo si aplica)
POST  /portal/hierarchy                        → Crear nodo (merchant_admin)
PATCH /portal/hierarchy/:nodeId                → Editar nombre/código/estado/padre (merchant_admin)
DELETE /portal/hierarchy/:nodeId               → Borrar nodo, rechaza si tiene hijos (merchant_admin)

GET   /portal/transactions                     → Transacciones del PROPIO merchant (read-only, paginado + filtros)
GET   /portal/transactions/:paymentId          → Detalle de una transacción propia (otro merchant → 404)
GET   /portal/analytics/summary                → KPIs del PROPIO merchant (importes en céntimos)
GET   /portal/billing                          → Factura-borrador del mes + historial (merchant_admin)
GET   /portal/billing/:period                  → Factura del período: finalizada (inmutable) o borrador (merchant_admin)
GET   /portal/invoices                         → Facturas emitidas del PROPIO merchant (merchant_admin)
GET   /portal/invoices/:invoiceId/pdf          → Descargar el PDF de una factura propia (merchant_admin)
GET   /portal/contract                         → Tarifa (rate-card) precargada del PROPIO merchant (merchant_admin)

GET   /portal/acquirers                         → Catálogo + fichas de adquirente del merchant (merchant_admin)
PUT/DELETE /portal/acquirers/:code              → Crear/editar (margen ICH++) / borrar ficha (merchant_admin)
GET/PUT /portal/routing                         → Reglas de routing estático (BIN routing) (merchant_admin)
POST  /portal/routing/simulate                  → ¿A qué adquirente iría esta tarjeta? (merchant_admin)
GET   /portal/costs                             → Coste real estimado por transacción + disclaimer (merchant_admin)
```

Facturación/precios internos (superadmin, sesión backoffice):

```
GET   /backoffice/pricing                       → Precios de todos los planes
PUT   /backoffice/pricing/:plan                 → Fijar/editar precios de un plan (sin desplegar)
GET   /backoffice/billing?period=YYYY-MM         → Factura de todos los merchants (+ finalized por merchant) + gran total
POST  /backoffice/billing/:merchantId/finalize   → Finalizar (congelar) la factura de un merchant (período cerrado)
POST  /backoffice/billing/finalize               → Finalizar todos los merchants de un período cerrado

GET/PUT /backoffice/company                      → Datos de la Sociedad emisora (M7 Bloque 1)
GET   /backoffice/tax  · PUT /backoffice/tax/:code → Tipos de IGIC configurables
GET/PUT /backoffice/merchants/:id/contract       → Contrato/rate-card por merchant
GET   /backoffice/invoices/:id/pdf               → Descargar el PDF de cualquier factura
POST  /backoffice/invoices/:id/send              → Enviar la factura por email + marcar enviada
POST  /backoffice/billing/run                    → Facturación mensual: finalizar (y opc. enviar) un mes cerrado
GET   /backoffice/billing/export?period=          → Export CSV de un período para el ERP

GET/PUT /backoffice/acquirers[/:code]            → Catálogo de adquirentes + scheme fees (CSF) (M7 Bloque 2)
GET/PUT /backoffice/interchange[/:scheme/:cardType/:region] → Tablas de interchange VISA/MC
```

Portal VISUAL (SPA): servido en **`/portal-app`** (`https://.../portal-app`). Consume solo `/portal/*`.

Auth: `Authorization: Bearer <JWT de portal>` (aud `portal`). El merchantId sale de la
sesión, nunca del cliente. Siembra del 1er merchant_admin por el superadmin interno:

```
GET  /backoffice/merchants/:merchantId/portal-users   → Listar (superadmin)
POST /backoffice/merchants/:merchantId/portal-users   → Crear (superadmin) → devuelve tempPassword una vez
```

Auth: JWT de backoffice (sesión de `/backoffice/auth/login`, rol `superadmin`).

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

*Sesión 20 julio 2026 (M7 Bloque 2 — adquirentes + coste real, IMPLEMENTADO de forma autónoma) — Continuación en `main`. Multi-adquirente preparado para N (hoy solo Paylands vivo). La adquirencia es INFORMATIVA (no se factura). Construido: catálogo `Acquirer` (+ scheme fees/CSF que pasa el adquirente), ficha `MerchantAcquirer` (margen ICH++ negociado por merchant), routing estático `MerchantRoutingRule` (BIN routing) con resolver (1ª regla que casa → si ninguna, default), tablas `InterchangeRate` (defaults EEA regulados reales + placeholders), y el **motor de coste real** (`costService`): interchange + scheme fees + margen adquirente + fee pasarela = coste efectivo por transacción, con **disclaimer** (aproximado, lo fijan las marcas VISA/MC). Portal (merchant_admin): pestañas Adquirentes (fichas + margen + routing + simulador) y **Coste real** (el "número grande" + tasa efectiva + desglose). Backoffice (superadmin): catálogo+CSF e interchange. **13 tests nuevos verdes** (coste, routing, endpoints + aislamiento); suite **238/247**. `openapi.yaml` v2.8.0. **M7 COMPLETO** (Fases 1-2 + Bloques 1-2). **Limitación v1**: routing a N en el flujo vivo cuando haya 2º conector; on-us cuando haya datos. **Sigue pendiente desplegar M6+M7** (todo en `main`, no es prod). Pendientes de fondo: 2º adquirente real, base de BINes/interchange más completa, enganche ERP.*

*Sesión 20 julio 2026 (M7 Bloque 1 — facturación real, IMPLEMENTADO de forma autónoma) — Marcos redefinió la Fase 3: **nada de Stripe/Paddle**; Monetiser emite la factura de LO NUESTRO (pasarela + servicios; la adquirencia es informativa, capa tecnológica no payfac), la carga en el perfil del merchant, la envía por email y ellos la descargan para el ERP. **Sociedad en Canarias ⇒ IGIC (no IVA)** — modelado con tipos IGIC (7% general por defecto) + no sujeto/ISP para Península/UE. Construido completo y autónomo (Marcos salió de casa): CompanyProfile (emisor), TaxRate (IGIC configurable), MerchantContract (rate-card por merchant: mantenimiento + fee/tx + volumen + usuarios + servicios), factura oficial con numeración correlativa (InvoiceCounter, $inc atómico) + snapshots + PDF (pdfkit) + email (nodemailer sobre SMTP de Google Workspace, vars SMTP_*), y distribución (portal descarga PDF + ve su tarifa; backoffice: PDF, enviar, facturación mensual `POST /billing/run`, export CSV para ERP). El billing usa el contrato o cae a plan. **Tests nuevos verdes** (billing por contrato con IGIC, factura oficial, humo PDF); suite **225/234**. `openapi.yaml` v2.7.0, DEV-LOG y CLAUDE.md. Deps nuevas pdfkit+nodemailer (este repo versiona node_modules, sin .gitignore — el commit del backend fueron ~1020 archivos por eso). **Aviso fiscal**: correcta por construcción; validez legal (Verifactu/SII) la confirma el asesor. **Qué desplegar/probar (cuando despliegues):** ENV `SMTP_HOST/PORT/USER/PASS/FROM` (Google Workspace) para el email; rellena `PUT /backoffice/company` (datos de la Sociedad) y `PUT /backoffice/merchants/:id/contract` (tarifa); luego el portal muestra la tarifa y las facturas con descarga PDF. **Sigue pendiente desplegar M6+M7 (todo en `main`, no es prod).** Siguiente: Bloque 2 (adquirentes + coste real por transacción) — Marcos dijo que continuáramos con él tras el Bloque 1.*

*Sesión 20 julio 2026 (M7 Fase 2 — cierre/finalización de facturas, IMPLEMENTADO) — Continuación de M7 en `main`. Se puede FINALIZAR (congelar) la factura de un período CERRADO: `BillingRecord` persiste nº de factura + snapshot de precios + cifras congeladas; `finalizeBilling` es idempotente (no recalcula ni duplica) y rechaza el mes en curso/futuro (`period_not_closed`). Una factura finalizada es inmutable aunque cambien transacciones antiguas. Portal: `GET /portal/invoices` + `GET /portal/billing/:period` (finalizada o borrador) + sección "Facturas emitidas" con **factura imprimible** (window.print → PDF). Backoffice: finalizar uno o todos los merchants de un período. **9 tests nuevos verdes** (idempotencia, guarda de período, inmutabilidad, aislamiento de facturas); suite **221/230**. `openapi.yaml` v2.6.0 (schema `Invoice`). **Sigue pendiente desplegar/probar M6+M7 en el servidor.** Pendiente M7: Fase 3 (cobro real Stripe/Paddle, activa `status:'paid'`). Marcos comentó que después dirá "unos extras" a hacer.*

*Sesión 20 julio 2026 (M7 Fase 1 — billing: medición y cálculo, IMPLEMENTADO) — Tras cerrar M6, Marcos eligió arrancar M7 (billing) directamente en `main`. **Fase 1 = medir y calcular lo que debe cada merchant; NO se cobra dinero real** (eso es Fase 3). Modelo de precios FLEXIBLE (cuota mensual + fee por transacción + % de volumen, en céntimos, editable sin desplegar vía `PUT /backoffice/pricing/:plan`; defaults = placeholders). `billingService.computeBilling` agrega las transacciones facturables (approved/authorized/captured) del mes y aplica las tres dimensiones. Portal: `GET /portal/billing` (+`/:period`), solo `merchant_admin`, scoped a la sesión (cada merchant ve solo lo suyo) + pestaña "Facturación" en la SPA. Backoffice: pricing GET/PUT + billing global (superadmin). **12 tests nuevos verdes** (cálculo + aislamiento); suite **212/221** (misma línea base). `openapi.yaml` v2.5.0. **Nota:** el modelo elegido es el flexible (recomendado) — cubre suscripción/por-uso/híbrido; Marcos pone los números reales cuando quiera. **Recordatorio importante: M6 y M7 siguen SIN desplegar/probar en el servidor** (todo en `main`, que no es producción). **Qué desplegar/probar (cuando despliegues):** mismo deploy; pon precios reales con `PUT /backoffice/pricing/:plan` y mira la pestaña "Facturación" del portal. Pendiente M7: Fase 2 (persistir/finalizar factura) y Fase 3 (cobro real Stripe/Paddle).*

*Sesión 20 julio 2026 (M6 Fases 3 y 4 — portal visual + permisos por nodo, IMPLEMENTADO; M6 COMPLETO) — Marcos pidió hacer Fase 3 y 4, y que **todo el desarrollo vaya en `main`** (sin ramas nuevas). Hecho: la rama `claude/m6-merchant-users-tenant-g75zhd` (Fases 1-2) se fusionó a `main` por fast-forward, y Fases 3-4 se desarrollaron directamente en `main`. **Fase 3 (datos + visual):** endpoints read-only scoped a la sesión (`GET /portal/transactions`, `/portal/transactions/:id`, `/portal/analytics/summary`; una tx de otro merchant → 404) + SPA vanilla en `public/portal/` servida en `/portal-app`, que habla solo con `/portal/*` (login → cambio de password → dashboard: Resumen/Transacciones/Usuarios/Jerarquía). **Fase 4 (permisos por nodo):** el JWT del portal lleva `hierarchyNodeId`; un admin asigna usuario→nodo con `PATCH /portal/users/:id`; un usuario asignado a un nodo solo ve/gestiona su subárbol (fuera → 404 / `403 outside_your_scope`). **Limitación anotada:** las transacciones no llevan referencia de nodo, así que el node-scoping aplica a la jerarquía, no a transacciones (mejora futura). **18 tests nuevos verdes** (portalData, portalNodePerms); suite **200/209** (misma línea base). `openapi.yaml` v2.4.0, DEV-LOG y CLAUDE.md actualizados. **Qué desplegar/probar (cuando despliegues):** el deploy es el mismo (la ENV `PORTAL_JWT_SECRET` de Fase 1 basta); tras Manual Deploy, entra en `https://<servidor>/portal-app`, haz login con el merchant_admin sembrado, cambia la password, y verás las 4 pestañas con datos SOLO de tu merchant. **M6 cerrado** (Fases 1-4). Siguiente hito real: aprovisionamiento en Paylands (bloqueado por la decisión agregador-vs-cuenta-por-merchant) y M7 billing.*

*Sesión 20 julio 2026 (M6 Fase 2 — jerarquía de tiendas, IMPLEMENTADO) — Marcos pidió continuar con la jerarquía "si no colisiona con nada crítico". **Análisis de colisiones:** NADA crítico — la jerarquía estaba dormida (ningún `require` la usa; solo dos punteros apagados en Merchant/MerchantUser), no montada, sin tocar nada de Paylands. Único punto no verificable desde aquí: si una versión antigua dejó una colección `merchanthierarchies` con datos/índice único viejos en la BD. **Neutralizado por diseño:** la jerarquía nueva usa una colección NUEVA (`hierarchynodes`), así la vieja (exista o no) queda intacta y aparte — Marcos no tiene que revisar nada. La "colisión" real era conceptual: el modelo viejo usaba `merchantId` para "id de tienda", chocando con el resto del sistema (tenant); resuelto rehaciéndolo como **árbol por-tenant** (`HierarchyNode`: merchantId=tenant dueño inmutable, nodeType, parentId). CRUD en `/portal/hierarchy` con el mismo aislamiento por sesión (nodo de otro merchant → 404; `parentId` a otro tenant → 404). Lectura para cualquier rol; escritura solo merchant_admin. Regla de nivel del padre (impide ciclos). DELETE rechaza nodos con hijos. `MerchantHierarchy.js` retirado (verificado que nadie lo requería) y refs actualizados a `HierarchyNode`. **22 tests nuevos verdes** (CRUD, reglas de árbol, roles, aislamiento). Protocolo CLAUDE.md: arranque limpio + suite **182/191** (misma línea base). `openapi.yaml` v2.3.0 + DEV-LOG. **Qué desplegar/probar (cuando despliegues):** mismo deploy que Fase 1 (no hay ENV nuevas); con un token de portal ya logueado y con la password cambiada — `POST /portal/hierarchy {"nodeType":"globalGroup","name":"Grupo"}` → 201; cuelga hijos con `parentId`; `GET /portal/hierarchy` → solo lo tuyo; intenta `PATCH`/`DELETE` un nodo de otro merchant → 404. Pendiente: Fase 3 (portal visual) y Fase 4 (permisos por nodo).*

*Sesión 20 julio 2026 (M6 Fase 1 — plano de usuarios de merchant + portal, IMPLEMENTADO) — Arranca M6 con el alcance de Marcos: onboarding SIEMPRE operado por Monetiser (el cliente no se autorregistra). Antes de escribir, propuesta de fases y dos decisiones de arquitectura, ratificadas por Marcos: **(1) modelo nuevo `MerchantUser`** (colección propia, separada de `BackofficeUser`) en vez de extender — colecciones distintas = una query del plano merchant nunca puede devolver un usuario interno; **(2) portal con superficie separada** (`/portal/*` + SPA propia en fases posteriores) en vez de reutilizar la SPA de admin con gates — no meter código cross-merchant en el navegador del merchant. **Fase 1 (backend, sin UI):** modelo `MerchantUser` (merchantId inmutable, roles fijos v1 merchant_admin/operator/viewer, mustChangePassword, puente hierarchyNodeId dormido); auth del portal con JWT propio (`PORTAL_JWT_SECRET`, aud `portal`) — un token de backoffice se rechaza aquí (sin aud) y uno de portal en el backoffice (secretos distintos, requisito de config); rate limit del login por IP+email; password temporal + cambio obligatorio en el primer login (sin infra de email); CRUD `/portal/*` con **aislamiento en servidor** (merchantId SIEMPRE de la sesión, cross-tenant → 404, es la lección del bug §4 sin repetir); siembra del 1er merchant_admin por el superadmin interno en `/backoffice/merchants/:merchantId/portal-users` (devuelve tempPassword una vez). Proyección pública explícita (el passwordHash no se serializa). **Tests: 32 nuevos, todos verdes** (auth+password temporal, CRUD+gates de rol, AISLAMIENTO A↔B, separación de planos, rate limit 429), con helper de modelo en memoria (no hay mongodb-memory-server). **Protocolo CLAUDE.md verificado:** arranque de la app con grafo de requires limpio + suite **160/169** (misma línea base — los 9 fallos siguen siendo los preexistentes de webhooks.test.js). `openapi.yaml` v2.2.0 (tag Portal, `PortalBearer`, 5 rutas, 7 schemas) y DEV-LOG actualizados. **Aclaración sobre la nota "no empezar M6 sin la decisión agregador-vs-cuenta-por-merchant" (18 jul):** esa decisión bloquea el *aprovisionamiento en Paylands*, que Marcos deja FUERA de alcance en M6; la gestión de usuarios/tenant no depende de ella. **Qué desplegar y probar (Marcos, Manual Deploy en Render):** ver el runbook al final de esta nota. Pendiente: Fase 2 (jerarquía — el modelo `MerchantHierarchy` actual es PLANO, hay que rediseñarlo a árbol por-tenant), Fase 3 (portal visual), Fase 4 (permisos por nodo).*

*→ **RUNBOOK M6 FASE 1 — para Marcos (todo contra el servidor Render):** **(0) ENV nuevas en Render antes de desplegar:** `PORTAL_JWT_SECRET=<algo largo y aleatorio, DISTINTO de BACKOFFICE_JWT_SECRET>`. (Opcionales: `RL_PORTAL_LOGIN_MAX`, `RL_PORTAL_LOGIN_WINDOW_MS`.) Luego Manual Deploy → Deploy latest commit → esperar Live. **(1) Sembrar el 1er merchant_admin** (con la sesión de superadmin del dashboard, o su JWT): `POST /backoffice/merchants/demo-merchant/portal-users`, `Authorization: Bearer <JWT superadmin>`, body `{"name":"Admin Demo","email":"admin@demo.com"}` → `201` con `tempPassword` (apúntala, no se repite). **(2) Login del portal:** `POST /portal/auth/login`, body `{"email":"admin@demo.com","password":"<tempPassword>"}` → `200` con `token` y `mustChangePassword:true`. **(3) Comprobar el bloqueo:** `GET /portal/users` con `Authorization: Bearer <token>` → `403 password_change_required`. **(4) Cambiar la password:** `POST /portal/auth/change-password` con ese token, body `{"currentPassword":"<tempPassword>","newPassword":"<nueva de 8+>"}` → `200` con un `token` nuevo. **(5) Ya con el token nuevo:** `GET /portal/users` → `200` (solo usuarios de demo-merchant); `POST /portal/users` body `{"name":"Op","email":"op@demo.com","role":"merchant_operator"}` → `201` con su `tempPassword`. **(6) Aislamiento (si hay un 2º merchant con usuarios):** intentar `PATCH /portal/users/<id de un usuario de OTRO merchant>` → `404`. **Lo que confirma cada paso:** que el plano merchant funciona aislado, que el token de un plano no vale en el otro, y que la password temporal obliga al cambio. NADA de esto toca Paylands.*

*Sesión 18 julio 2026 (Test D — POSPUESTO a una sesión en Mac) — A/B/C ya verificados en producción (ver nota siguiente). Falta el **Test D** (S2S→payNoPain real con 3DS), que es lo único para poder subir S2S de `beta` a `estable`. Marcos está en iPad sin terminal; **decidido hacerlo en una sesión nueva desde el Mac**, donde el runbook de curl es trivial. **RUNBOOK TEST D — listo para ejecutar en Mac (todo Paylands SANDBOX vía el servidor Render, sin dinero real):** **(1) Enrutar S2S a payNoPain** — `PUT /rules/demo-merchant`, header `X-Admin-Token: <ADMIN_TOKEN>`, body `{"version":"v1","defaultConnector":"payNoPain","rules":[],"fallback":{"order":["payNoPain"],"on":["network_error"]}}` → 200. Con `rules:[]` el motor enruta al `defaultConnector` (verificado en `ruleEngineV2.evaluate`: sin reglas devuelve `connector = policy.defaultConnector`). **(2) Conseguir un `source_uuid` real** (lo genera ProxyFields, NUNCA es el PAN): _opción recomendada (NO construida aún)_ = helper solo-lectura `GET /diag/card-token?reference=<paymentId>` que devuelva `pciProxy.getTokenizationResults(reference).token`; _opción manual_ = crear un Hosted Checkout, meter la tarjeta de test `4018810000100036` (12/34, CVV 123) en el iframe, y recuperar el token del Proxy PCI → `POST https://pci-proxy-api.paynopain.com/sandbox/customers` con `{"apiKey":"<PAYNOPAIN_API_KEY>","signature":"<PAYNOPAIN_SIGNATURE>"}` (el JWT viene en `resp.apiKey`), luego `GET https://pci-proxy-api.paynopain.com/sandbox/card/reference/<paymentId>` con `Authorization: Bearer <JWT>` → el campo `token` del primer elemento del array es el `source_uuid`; _opción C_ = portal Paylands sandbox. **(3) Lanzar el S2S** — `POST /demo-merchant/payments/server`, headers `x-api-key: mk_7065b5507c6efae4d1067f2768919154` + `x-merchant-id: demo-merchant`, body `{"source_uuid":"<UUID>","cardPaymentMethodSpecificInput":{"threeDSecure":{"redirectionData":{"returnUrl":"https://example.com/return"}}},"order":{"amountOfMoney":{"amount":1000,"currencyCode":"EUR"}},"feedbacks":{"webhookUrl":"https://webhook.site/<uuid>"}}`. Esperado: `200`, `status:pending_3ds`, `connectorUsed:payNoPain`, `merchantAction.actionType:REDIRECT` con la URL de 3DS. Apuntar el `paymentId`. **(4) Completar el 3DS** abriendo esa URL en el navegador (challenge del sandbox). **(5) Verificar** — `GET /diag/transactions?paymentId=<id>` con `X-Admin-Token` → `status:authorized`, `_diag.webhookReceived:true`, `lastWebhookRaw.status:PENDING_CONFIRMATION` (mapea a authorized en DEFERRED); y en webhook.site un `payment.updated` con header `Monetiser-Signature`. **(6) Revertir el routing** — `PUT /rules/demo-merchant` con `defaultConnector:"dummyCard"` y `fallback.order:["dummyCard"]` (restaura la base de A/B/C). **Incierto, anotar el resultado:** si el mismo `source_uuid` admite dos cobros (el del hosted del paso 2 + el del S2S del paso 3) contra Paylands sandbox — card-on-file dice que sí, pero sin verificar; si Paylands lo rechaza NO es bug de Monetiser (usar entonces un source_uuid fresco sin cobrar antes). **Ofrecido y NO construido (decisión pospuesta al Mac):** (a) el helper `GET /diag/card-token` (colapsa el paso 2 a una sola petición y elimina manejar los secretos `PAYNOPAIN_*`), (b) una colección de Postman con todo el Test D montado (para poder hacerlo desde iPad si hiciera falta). Con D en verde → subir S2S de `beta` a `estable` en `openapi.yaml` y cerrar el último bloqueante técnico previo a M5.*

*Sesión 18 julio 2026 (S2S tokens-only — MERGE + VERIFICADO EN PRODUCCIÓN) — El trabajo descrito en la nota siguiente se fusionó a `main`: PR #1 (squash) → commit `24d8dc4`. Rama `claude/s2s-tokens-only-b7r033` retirada en local; la remota la cierra Marcos desde el PR (el proxy de git de la sesión NO permite borrar ramas — 403 de política, no se reintenta). **Deploy:** Marcos hizo Manual Deploy de `24d8dc4` en Render y se confirmó **Live** — evidencia: el Test A devolvió el `400` nuevo, que el código viejo (que aceptaba el PAN) no daba. **Verificado en producción vía curl (Render, `PAYNOPAIN_ENV=sandbox`), 18 jul:** (A) PAN en crudo → `400 card_data_not_accepted`; (B) sin token → `400 missing_card_token`; (C) con `source_uuid` → `200` `status:authorized` `connectorUsed:dummyCard` (tx de prueba `bedb572a-ba86-41f1-b177-14a05800bbf4`, dummyCard, sin dinero real). O sea: el gating tokens-only (rechazo de PAN / exigencia de token) y el happy-path por la ruta por defecto (dummyCard) quedan verificados EN VIVO. **`openapi.yaml` se mantiene en `beta`** (correcto): lo único que falta para `estable` es el **Test D — S2S→payNoPain real con 3DS**, que sigue PENDIENTE. **Matiz sobre el Test D (duda de Marcos, aclarada aquí):** D NO es Paylands producción ni dinero real. Se ejecuta *a través del servidor de Render* (único entorno con credenciales reales de PayNoPain, y necesario porque Paylands entrega el webhook de cierre a `SERVER_URL/webhooks/paynopain`, que debe ser una URL pública — desde el Mac en local no llegaría), pero **contra Paylands SANDBOX** (`PAYNOPAIN_ENV=sandbox`, tarjetas de test `4018810...`, sin dinero). "Prod" solo en el sentido de "el servidor desplegado en Render", jamás Paylands producción. Requisitos de D: (1) una regla de routing que enrute S2S a `payNoPain` (pestaña Reglas o `PUT /rules/demo-merchant` con `defaultConnector:"payNoPain"`), y (2) un `source_uuid` real de ProxyFields (hoy solo se genera dentro del iframe del Hosted Checkout).*

*Sesión 18 julio 2026 (S2S tokens-only — IMPLEMENTADO) — Ejecutada la decisión A ratificada (fila S2S de la sección 5). **Tres cambios de código + tests, con el protocolo de CLAUDE.md (arranque de la app + jest) antes de cerrar.** (1) **Rechazo del PAN en S2S:** `serverPaymentController.js` rechaza `cardNumber`/`cvv` en crudo con `400 card_data_not_accepted` (mensaje explícito de SAQ A) ANTES de validar estructura, y exige el token de ProxyFields en el campo raíz `source_uuid` o en `cardPaymentMethodSpecificInput.token` (`400 missing_card_token` si falta). Ya no arma `paymentData` con datos de tarjeta: pasa `cardToken`. `serverPaymentDTO.js` admite `source_uuid` a nivel raíz. **No se tocó `CardDTO` compartido** (lo usa también Hosted Checkout) — el rechazo es del flujo S2S, no del nodo estructural. (2) **`authorize()` en `payNoPainConnector.js`:** añadido y exportado; exige `cardToken`, reutiliza `chargeWithToken` (ya en `operative: DEFERRED`, envía el token como `source_uuid`) y normaliza a `requires3DS`/`approved`/`declined`. Cierra el "`connector.authorize is not a function`" que reventaba si una regla enrutaba S2S a `payNoPain`. Para que el 3DS no se confunda con un decline: `connectorRegistry.adaptPayNoPain` propaga `requires3DS`/`threeDsUrl`, y `paymentService.processCardPayment` devuelve `status: pending_3ds` (sin fallback) que el controller convierte en `merchantAction: REDIRECT` a la URL 3DS tokenizada; Paylands cierra la tx por webhook (localiza por `processorReference`). (3) **Tests:** `serverPayment.test.js` reescrito a tokens-only (rechazo de PAN y de cvv, token en ambas grafías, falta de token, `pending_3ds`→REDIRECT) + nuevo `tests/unit/payNoPainAuthorize.test.js` con `https` mockeado (existe `authorize`; `missing_card_token` sin tocar red; `requires3DS` verificando que el body a Paylands lleva `source_uuid = cardToken` y `operative: DEFERRED`; `declined` en no-200). **Verificación:** app arranca con grafo de requires limpio (sin `MODULE_NOT_FOUND` ni warnings de routers); suite **128/137 = misma línea base** (los 9 fallos siguen siendo los preexistentes de `webhooks.test.js`) con **+9 tests nuevos verdes**. **`openapi.yaml` → v2.1.0:** S2S deja de ser `experimental`/`deprecated` y pasa a **`beta`** (nivel nuevo: contrato cerrado e implementado pero **sin verificar end-to-end contra Paylands real**; se documenta como tal, no como `estable`, para no afirmar una verificación que no se ha hecho). Schema `ServerPaymentRequest` actualizado (tokens-only, `source_uuid`/`token`), nota de scope PCI ampliada a S2S. **Esto cierra el bloqueante de CÓDIGO previo a M5**; la validación PCI FORMAL de Monetiser como proveedor sigue siendo M5 (PayNoPain/QSA), no se promete nada regulatorio aquí. Pendiente de Marcos: una prueba real S2S→payNoPain contra Paylands sandbox antes de promover S2S de `beta` a `estable`.*

*Sesión 18 julio 2026 (decisiones de negocio, tras completar la checklist) — Tres decisiones de Marcos: **(1) Adquirente único por ahora:** se confía en Paylands como único adquirente real hasta conseguir uno adicional; Nassau sigue en negociación comercial sin fecha y NO bloquea nada. Consecuencia asumida: el routing/fallback multi-adquirente (la propuesta de valor central) queda en espera de un segundo conector real. **(2) Agregador vs cuenta-por-merchant en Paylands: decisión APLAZADA explícitamente al arranque de M6.** Compromiso: volver a ponerla sobre la mesa ANTES de diseñar el onboarding, porque el flujo de alta de merchants es completamente distinto en cada modelo (y el modelo agregador tiene implicaciones regulatorias PSD2 que evaluar). NO empezar M6 sin esta decisión. **(3) S2S tokens-only RATIFICADO** — ver detalle y matiz SAQ A en la fila S2S de la sección 5; implementación en la próxima sesión. Además: documentado en `openapi.yaml` el prerequisito de captura para el refund con DEFERRED (hallazgo de las pruebas del 18 jul) y añadida la lección del orden del ciclo de vida a CLAUDE.md.*

*Sesión 17 julio 2026 — AUDITORÍA Y LIMPIEZA APROBADAS POR MARCOS, ejecutadas en 4 tandas (cada una con grafo de requires verificado + arranque de la app + suite 119/128 antes de commitear). **Tanda 1, seguridad (`a7bad5e`):** retirados `/initialize`, `/tokens` (guardaba PAN cifrado en Mongo — bóveda propia, SAQ D) y `/payment-requests`; eliminado `POST /transactions/card-payment` (PAN en crudo); `PUT`/`DELETE`/`POST /transactions` eliminados por permitir escritura/borrado **cross-tenant** (sin comprobación de pertenencia al merchant); `transactionController` reescrito solo-lectura con scoping obligatorio por `req.merchantId` también en las analíticas. **Tanda 2, código muerto (`9b8ad79`):** eliminados 58 archivos no alcanzables desde `index.js` ni desde los tests — isla PMS completa (Cloudbeds, de otro proyecto), cadena legacy huérfana (ruleEngine V1, acquirers mock, conectores APM mock, orquestador viejo, binService/BinCache/binRefreshCron, RecurrentProfile), y duplicados (3 modelos de idempotencia, `utils/crypto`, `core/tokenService`, errorHandlers, etc.); fuera de `package.json`: `multer`, `csv-parser` y `winston` (huérfanas). SE CONSERVAN a propósito `MerchantHierarchy` (standby enterprise) y `seedDemoMerchantKey`. **Tanda 3, webhooks (`48abb69`):** `sendWebhookIfAny` delega en `webhookDispatcher.enqueue()` — una sola firma (`Monetiser-Signature`), secreto por-merchant, reintentos y registro para TODOS los eventos salientes; evento `payment.canceled`→`payment.cancelled`. **Tanda 4, spec (`ad415b8`):** `openapi.yaml` v2.0.0 refleja todo lo anterior (22 rutas, 4 webhooks, 21 schemas, validado). **VERIFICADO EN VIVO el 18 jul 2026 (Marcos, Postman + webhook.site contra producción):** endpoints retirados → 404 los siete; `GET /transactions` → 401 sin auth, 200 con scoping correcto (solo demo-merchant), analíticas OK; pago completo Hosted Checkout → `authorized`; capture → `captured`; refund parcial 500 → `partially_refunded`; webhooks salientes `payment.updated`, `payment.captured` (capturedAmount 1000) y `payment.refunded` (refundedAmount 500) recibidos en webhook.site **con header `Monetiser-Signature` y SIN `x-monetiser-signature` ni `x-monetiser-timestamp`** — la unificación de emisores funciona en producción. **Hallazgo de la sesión de pruebas:** refund sobre un pago `authorized` SIN capturar (DEFERRED) → Paylands devuelve 409 Conflict (Monetiser lo envuelve como 502 `refund.processor_declined`). Es semántica correcta del procesador — con DEFERRED no hay dinero movido que reembolsar hasta capturar — pero Monetiser lo deja pasar porque `REFUNDABLE_STATUSES` incluye `authorized` (compatibilidad con tx antiguas del modo AUTHORIZATION). **Mejora anotada (no urgente, no tocar en caliente):** rechazar en local con 409 propio y mensaje claro ("captura primero o cancela") cuando `status=authorized` y `capturedAmount=0`. **PENDIENTE: bloque E de la checklist** — cancel sobre una autorización sin capturar y verificación del webhook `payment.cancelled` (dos L, evento renombrado en esta sesión).* **→ COMPLETADO 18 jul 2026:** cancel sobre autorización DEFERRED sin capturar → 200 `{"status":"cancelled"}` (dos L, fix del 16 jul intacto tras la limpieza), y los dos webhooks salientes de esa transacción (autorización + cancelación) entregados en webhook.site. Único fleco menor: la comprobación visual del nombre `payment.cancelled` en el payload quedó pendiente por hacerse desde iPad — mismo código ya verificado en capture/refund, riesgo residual; Marcos lo mira desde el Mac en la misma URL de webhook.site (las peticiones persisten). **Checklist de la sesión del 17 jul: COMPLETA. Toda la sesión (retiradas de seguridad, limpieza de 58 archivos, unificación de webhooks) está verificada en producción.**

*Última revisión: 16 julio 2026 — Ciclo de vida DEFERRED VERIFICADO end-to-end al COMPLETO: refund (total y parcial), capture y cancel confirmados funcionando contra Paylands real. Claves del arreglo: (1) endpoints reales `/payment/confirmation` y `/payment/cancellation`; (2) operative AUTHORIZATION→DEFERRED en las 3 funciones de creación de orden; (3) mapeo del status `PENDING_CONFIRMATION`→`authorized` en el webhook; (4) declarados `lastWebhookAt`/`lastWebhookRaw` en el esquema Transaction (Mongoose los descartaba en silencio); (5) fixes de validación en refundSchema y de normalización dummyCard. Lección operativa recurrente: confirmar SIEMPRE que Render terminó de desplegar antes de probar — varios falsos negativos se debieron a probar contra el código viejo. M1, M2 y M3 completados. Bloqueante crítico pendiente: S2S acepta PAN en crudo (incompatible con SAQ A) — decidir tokens-only vs scope PCI mayor antes de M5. Tarjetas test buenas: 4018810...*

*Sesión 16 julio 2026 (tarde, cont.) — M4 COMPLETADO: `openapi.yaml` en la raíz (OpenAPI 3.1, v1.0.0, 23 rutas / 27 operaciones / 21 schemas / 4 webhooks salientes / 0 refs rotas, validado con js-yaml). Una sola spec: eliminada `openapi/monetiser.yaml` y portado su contenido íntegro tras verificar que nada la referenciaba. Cada campo sale de los DTOs y validators reales. S2S documentado como `experimental` + `deprecated: true` conforme a la decisión A. **Cuatro hallazgos al escribirla, todos documentados en la spec y anotados en la sección 5** — el grave es el primero: (1) los webhooks salientes tienen TRES emisores independientes con firmas incompatibles — `webhookDispatcher` (`Monetiser-Signature`, secreto por-merchant, reintentos, log), `sendWebhookIfAny` en paymentsController (`x-monetiser-signature`, solo secreto global, sin reintentos, sin log) y `core/webhookService` vía /apms (`Monetiser-Signature` pero solo secreto global, cola propia). Un merchant que verifique un header fallará el otro en silencio, y los emisores 2 y 3 envían SIN FIRMAR si el merchant tiene secreto propio pero no hay WEBHOOK_SECRET global. **No es un artefacto del entorno de test**: los nombres de cabecera son literales en el código, sin condicionales de entorno — en producción pasaría exactamente igual. Hoy no ha explotado solo porque no hay ningún merchant verificando firmas; (2) `capture` usa `amount` plano mientras `refund`/`cancel` usan `amountOfMoney.amount`; (3) en modo simple `x-api-key` lleva el keyId, no el secreto — el identificador actúa como credencial; (4) la firma HMAC usa `secretHash` (SHA-256 del secreto) como clave, no el secreto. Nada de esto se ha "arreglado" en la spec: está documentado tal como es.*

*Sesión 16 julio 2026 (tarde, cierre) — RETIRADO EL STACK `/apms`. Al verificar si la divergencia de firmas de webhook dependía del entorno de test (no dependía: son literales en el código), apareció un tercer emisor y, tirando del hilo, un stack de pago paralelo completo heredado de una versión antigua: `POST /apms/payments` estaba **montado, era público y aceptaba el PAN en crudo**. Verificado en vivo contra Render: body vacío sin credenciales → `200` (el mismo intento contra `/payments/hosted` → `401`). Su auth era opt-in vía `APMS_REQUIRE_API_KEY`, variable inexistente en el repo y en Render; y su validación Joi no funcionaba porque `paymentValidator.js` machaca el `.validate` del schema con su propio helper (línea 93) — `{ error }` siempre `undefined`, fallo silencioso desde el día uno. Procesaba contra conectores simulados y los conectores de APM eran mocks declarados. **Eliminados 14 archivos + el montaje** (apmsHandler, transactionManager, webhookService, routingEngine, fraudEngine, simulator/backupSim, storage/*, apmHub + 4 conectores mock). Aislamiento verificado antes de borrar; ningún test los tocaba; suite en 119/128, idéntica a la línea base. Efecto colateral bueno: desaparece el tercer emisor de webhook, quedan dos. **Lección para el proyecto: un endpoint montado y olvidado es peor que código muerto — el código muerto no acepta tarjetas.** Corregida además la ruta del motor de reglas en la tabla de componentes: es `src/rules/ruleEngineV2.js`, no `src/core/`. Trampa que queda anotada y sin tocar: el `.validate` machacado de `paymentValidator.js` (ya sin víctima, pero es una mina para código futuro).*

*Sesión 16 julio 2026 (cierre real) — **DEPLOY Y VERIFICACIÓN EN VIVO.** **CORRECCIÓN IMPORTANTE DE MARCOS: en este proyecto el auto-deploy NO existe y nunca ha existido — todos los despliegues los lanza él a mano** (Manual Deploy en Render). No está roto: es así por diseño. Durante esta sesión se dio por hecho lo contrario (lo afirmaban tanto el prompt de sesión como versiones antiguas de este DEV-LOG) y se perdió una hora esperando un deploy automático que nunca iba a ocurrir. **Un commit en main NO está en producción: hay que pedirle a Marcos que despliegue.** Anotado en CLAUDE.md. (Contexto: un commit mío, `e903802`, dejó main sin arrancar durante ~25 min al borrar 3 conectores APM que `transactionController` requería directamente sin pasar por `apmHub`; arreglado en `2f5f51e`. `node --check` y `jest` no lo detectaron: hay que ARRANCAR la app. Lección incorporada a CLAUDE.md.) **Verificado tras el deploy contra el servidor real:** `/apms`→404 (cerrado); `/health`→200; `/demo-merchant/payments/hosted`→401; `/transactions`→401 (montado); `/payments/x/refund`→401; `/payment-requests`→401; `/admin`→200. **Flujo Hosted Checkout probado end-to-end por API:** crear→200 con `redirectUrl` · status→`hosted_pending` · `/hpp/:id`→302 firmado · iFrame→200 (17 KB, con ProxyFields dentro). **BUG ENCONTRADO Y ARREGLADO al verificar** (`3153984`): `canceled` vs `cancelled` — la API guardaba una L, el dashboard y el webhook de Paylands dos, y `hostedCheckoutController:260` solo reconoce dos → todo pago cancelado por API devolvía `completed:false` para siempre. Alineado a `cancelled`, **la grafía de Paylands** (`/payment/cancellation`, webhook `CANCELLED`) por criterio de Marcos. Dos sitios, no uno: el desplegable de filtro del dashboard (`dashboard.js:525`) también ofrecía `canceled` y **ya estaba roto de antes** — no encontraba las tx canceladas desde el propio dashboard. Corregido también un error mío en el OpenAPI: el enum de estados lo saqué del diagrama del DEV-LOG en vez del código y le faltaba `hosted_pending`, el estado de cualquier checkout recién creado; además `Transaction.status` no tiene `enum` en el modelo, así que la lista es observada, no garantizada.*

*Sesión 16 julio 2026 (tarde) — Tarea 1, deuda técnica menor. (1a) Eliminado el PAN de los logs: `proxyPciRoutes.js` (PROXY_PCI_TOKEN_RETRIEVED) y `pciProxyService.js` (PCI_PROXY_GET_RESULTS_OK) lo logueaban, junto con `tokenKeys` y 30 chars del token de tarjeta. No llegó a filtrarse porque `sanitizeData()` de `logger.js` lo redactaba por regex — el valor salía como `[REDACTED]`, así que quitarlos no perdió información — pero para SAQ A el PAN no debe llegar al logger. Corregido: el DEV-LOG describía una deuda que no existía (`fullBody`: cero ocurrencias en todo el repo) y no mencionaba la que sí existía (el PAN). `serverPaymentController.js` y `payNoPainConnector.js` estaban limpios. (1b) Documentados `FEATURE_RULE_TRY`/`AUDIT`/`EXPORT_UI` en la sección 8 — hallazgo relevante: `FEATURE_RULE_AUDIT` no solo muestra el histórico, también gatea la ESCRITURA de las entradas de auditoría (rulesController.js:78 y :217); apagado, los cambios de reglas se guardan sin rastro de autor y no se pueden reconstruir. **Confirmado después por Marcos: los tres YA estaban a `1` en Render**, así que no había nada que activar. Seguridad: retirado de CLAUDE.md el PAT de GitHub que estuvo publicado en el repo público del 11 al 16 de julio (troceado en dos mitades, lo que evitó que el secret scanning de GitHub lo auto-revocara) — Marcos lo revoca por su lado; quitarlo del archivo no lo borra del historial. Limpiadas además varias contradicciones internas del documento: capture/cancel figuraban a la vez como "verificados" y "sin verificar", y la sección 11 aún decía `operative: AUTHORIZATION`.*

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
   con una tarjeta de ejemplo y confirmar la explicación. **Los flags
   `FEATURE_RULE_TRY`/`AUDIT`/`EXPORT_UI` están confirmados a `1` en Render**
   (Marcos, 16 jul 2026), así que los cuatro botones deben responder. Si alguno
   dijera "función desactivada", entonces sí sería un problema de configuración.

Esto forma parte de M2/M3 y debe verificarse en sandbox antes de produccion.
