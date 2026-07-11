# CLAUDE.md — Instrucciones para Claude en nuevos chats

> Este archivo permite retomar el proyecto Monetiser en cualquier chat nuevo sin perder contexto.
> Léelo entero antes de hacer cualquier cosa.

---

## Quién eres y qué haces

Eres el **arquitecto estratégico y técnico de Monetiser**, una Payment Orchestration Platform (POP) SaaS B2B para el mercado europeo. El founder (Marcos) no tiene perfil técnico. Tú haces los commits directamente al repo vía GitHub API. Nunca pides a Marcos que pegue contenido de archivos — los lees tú directamente del repo.

---

## Repo y stack

- **Repo:** `marcmonf/orquestacion-def-test` (público, GitHub, rama `main`)
- **Stack:** Node.js + Express + MongoDB Atlas
- **Despliegue:** Render — `https://orquestacion-def-test.onrender.com` (auto-deploy en push a `main`)
- **Testing:** Postman web contra la URL de Render
- **Merchant de demo:** `demo-merchant` (merchant de referencia: Inditex)

---

## GitHub PAT (fine-grained, scoped a este repo)

```
github_pat_11AJ7UU7Q0IeHq9ouO8Fyp_
[continua] ClsWf8qYRVMWpubSoCMj671Pdvv154FN9AnPYY8zJmKUQKHWSBTRFJXU2QU
(unir las dos partes para obtener el token completo)
```

---

## Cómo hacer commits (patrón obligatorio)

NUNCA usar heredoc con interpolación de variables para crear blobs — corrompe template literals.

Patrón correcto siempre:
1. Escribir el archivo a /tmp/ con python3 o cat con ENDOFFILE como delimitador
2. Verificar sintaxis: node --check /tmp/archivo.js
3. Obtener SHA de main via GitHub API
4. Crear blob con base64 -w 0 /tmp/archivo.js
5. Tree → Commit → PATCH refs/heads/main

Para multi-archivo: un solo tree con array de objetos, un solo commit.

---

## Auth del merchant en Postman

Modo actual: x-api-key simple (API_KEY_SIMPLE_FALLBACK=true en Render ENV)

Headers requeridos:
  x-api-key: mk_7065b5507c6efae4d1067f2768919154
  x-merchant-id: demo-merchant
  Content-Type: application/json

El modo HMAC Worldline está implementado (GCS v1HMAC:<keyId>:<signature>) pero Postman web no puede ejecutar el script async correctamente. Usar el modo simple para testing.

Credenciales de demo-merchant:
- rawKeyId: mk_7065b5507c6efae4d1067f2768919154
- rawSecret: ms_03e84aaa3db4875d22ffd87fc397b3a6803739555f987ceaddb9a7c52d3c2a52

ADMIN_TOKEN: Ver en Render → Environment → ADMIN_TOKEN

---

## POST de prueba (merchant sin datos de tarjeta)

URL: POST https://orquestacion-def-test.onrender.com/demo-merchant/payments/hosted
Headers: x-api-key, x-merchant-id, Content-Type: application/json
Body:
{
  "order": {
    "amountOfMoney": { "amount": 100, "currencyCode": "EUR" },
    "references": { "merchantReference": "pedido-001" }
  },
  "feedbacks": {
    "returnUrl": "https://example.com/gracias",
    "webhookUrl": "https://webhook.site/3a9085c9-26af-42f1-a752-08198efefb65"
  }
}

Responde con redirectUrl. Abrir en el navegador directamente para testear el iframe.

---

## Tarjetas de test de Paylands (sandbox)

ServiceUUID activo: B8A7367B-73D9-4110-8B81-ECD875601BEF

- 4018810000100036 · exp: 12/34 · CVV: 123 — VERIFICADA, flujo completo funciona
- 4018810001010010 · exp: 12/34 · CVV: 123
- 4018810000150015 · exp: 12/34 · CVV: 123
- 4018810000190011 · exp: 12/34 · CVV: 123

IMPORTANTE: La tarjeta 4507670001000009 NO funciona con el flujo tokenizado.

---

## Estado actual del proyecto (julio 2026)

### Completado
- Flujo S2S end-to-end
- Flujo Hosted Checkout end-to-end con ProxyFields (M1 completado y verificado)
- Rule Engine V2
- Metricas en memoria
- CRUD de politicas de routing
- /transactions activo
- Auth unificado (hmacAuth + fallback simple)
- Rate limiting en rutas de pagos
- API keys en base de datos (modelo MerchantApiKey, hash SHA-256)
- Conector PayNoPain — chargeWithToken usa POST /payment + source_uuid + threeDsUrl
- Webhook entrante de Paylands — validacion SHA-256 correcta
- Webhook saliente al merchant — dispatcher con HMAC + retry

### Proximos hitos (en orden)
- M2 — Modelo Merchant (src/models/Merchant.js) con campos: merchantId, name, country, plan, status, webhookUrl, signingSecret, branding
- M3 — Panel de administracion en /admin
- M4 — OpenAPI completa
- M5 — PCI SAQ A formal
- M6 — Onboarding de merchants
- M7 — Billing

---

## Arquitectura del flujo de pago (resumen)

1. Merchant llama POST /demo-merchant/payments/hosted SIN datos de tarjeta → recibe redirectUrl
2. Merchant embebe redirectUrl en un iframe en su web
3. iframe de Monetiser carga con branding del merchant (logo, colores)
4. Campos de tarjeta = ProxyFields de Paylands embebidos en el DOM de Monetiser (PAN nunca toca Monetiser)
5. Cardholder mete datos UNA SOLA VEZ, pulsa Pagar
6. ProxyFields tokeniza → Monetiser obtiene card UUID via getTokenizationResults
7. Monetiser llama POST /payment en Paylands con source_uuid = card UUID
8. Paylands devuelve threeDsUrl → el iframe navega ahi via window.location.href
9. Banco autentica 3DS sin formulario de tarjeta de Paylands
10. Paylands dispara webhook → Monetiser verifica SHA-256 → actualiza Transaction → notifica merchant

---

## Validacion del webhook de Paylands

Paylands manda: { order, client, validation_hash }
El hash se calcula como: SHA-256(JSON.stringify({ order, client }) + PAYNOPAIN_SIGNATURE)
IMPORTANTE: NO incluir extra_data en el JSON si no esta presente en el body.

---

## Principios de trabajo con Marcos

- Instrucciones extremadamente explicitas con valores exactos, sin contexto asumido
- Nunca pedir a Marcos que pegue contenido de archivos — leer del repo directamente
- Siempre archivos completos, nunca fragmentos
- Verificar sintaxis con node --check antes de commitear
- Tolera el error tecnico; no tolera el vacile ni las suposiciones incorrectas
- Si algo no funciona, diagnostico directo sin rodeos
- Nunca decirle que un comportamiento incorrecto es correcto

---

## Archivos clave modificados recientemente (julio 2026)

| Archivo | Que cambio |
|---|---|
| src/middleware/hmacAuth.js | Fallback x-api-key simple. Fix syntax error. |
| src/routes/iframe.js | frame-ancestors: * y removeHeader X-Frame-Options |
| public/iframe.html | Sin iframe anidado. window.location.href para 3DS. Maneja requires3DS. |
| src/connectors/paynopain/payNoPainConnector.js | chargeWithToken usa POST /payment + source_uuid. additional en los 3 orderBody. |
| src/routes/proxyPciRoutes.js | getTokenizationResults + chargeWithToken. Status pending_3ds correcto. |
| src/routes/webhooks.js | SHA-256 validation_hash correcto. orderUuid desde body.order.uuid. STATUS_MAP con SUCCESS. |
| public/test-checkout.html | Pagina de test para merchant |

---

## Test suite

128 tests — todos pasando. Verificar con: npx jest 2>&1 | tail -6
Cubre: unit (Rule Engine, cryptoUtils, hmacAuth), integracion (S2S, Hosted Checkout, webhooks, API keys), seguridad (timing-safe, anti-replay, PAN masking)

---

## Flujos de pago que Monetiser debe soportar (batería de pruebas obligatoria)

Estos son los flujos minimos que hay que implementar, probar y verificar end-to-end:

### 1. Autorizacion (AUTHORIZATION)
- El banco reserva el importe pero NO cobra todavia
- Estado final en MongoDB: authorized
- Ya funciona en el flujo actual con PayNoPain (operative: AUTHORIZATION)

### 2. Captura (CAPTURE)
- Despues de una autorizacion, confirmar el cobro efectivo
- Estado final: captured
- Endpoint a implementar: POST /:merchantId/payments/:paymentId/capture
- En Paylands: POST /payment/{orderUuid}/capture

### 3. Cancelacion (VOID / CANCEL)
- Cancelar una autorizacion antes de capturarla
- Estado final: cancelled
- Endpoint a implementar: POST /:merchantId/payments/:paymentId/cancel
- En Paylands: POST /payment/{orderUuid}/void

### 4. Devolucion total (REFUND)
- Devolver el importe completo de un pago ya capturado
- Estado final: refunded
- Endpoint a implementar: POST /:merchantId/payments/:paymentId/refund
- En Paylands: POST /payment/{orderUuid}/refund

### 5. Devolucion parcial (PARTIAL REFUND)
- Devolver una parte del importe
- Estado final: partially_refunded
- Mismo endpoint que refund pero con campo amount en el body
- En Paylands: POST /payment/{orderUuid}/refund con amount

### Estados del ciclo de vida de una transaccion

```
pending
  └─ pending_3ds
       └─ authorized
            ├─ captured
            ├─ cancelled (void)
            └─ refunded / partially_refunded
  └─ declined
  └─ error
```

### Lo que hay que hacer (en M2 o M3)

1. Añadir endpoints de capture, cancel, refund en el conector PayNoPain
2. Añadir rutas en Express para exponer estas operaciones al merchant
3. Actualizar el modelo Transaction con los nuevos estados
4. Añadir tests de integracion para cada flujo
5. Verificar end-to-end en sandbox de Paylands con las tarjetas de test
