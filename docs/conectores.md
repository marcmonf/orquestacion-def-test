# Cómo añadir un PSP (adquirente) a Monetiser

> Guía para quien programe el conector del **segundo** adquirente (y los
> siguientes). Monetiser es un orquestador: el núcleo (checkout, ciclo de vida,
> routing, webhooks salientes, panel) **no conoce a ningún PSP concreto**. Habla
> con un **contrato** único. Añadir un PSP = escribir su carpeta, registrarlo y
> pasar la suite de contrato. **No se toca el núcleo.**

Ficheros de referencia:

| Qué | Dónde |
|---|---|
| El contrato (capacidades, operaciones, validación) | `src/connectors/contract.js` |
| La taxonomía de errores | `src/connectors/errors.js` |
| Conector de referencia real (Paylands) | `src/connectors/paylands/` |
| Conector de prueba "B" (solo tests, no es un PSP real) | `tests/helpers/testConnectorB.js` |
| Suite que todo conector debe pasar | `tests/contract/connectorContract.js` |
| Registro de conectores | `src/services/connectorRegistry.js` |
| Cuentas y credenciales cifradas por merchant | `src/services/connectorAccountService.js` |
| Routing pre-captura y salud (circuit breaker) | `src/services/routingService.js`, `src/services/connectorHealth.js` |

---

## Reglas que no se negocian

1. **PCI DSS SAQ A.** Ningún PAN ni CVV toca servidores, logs ni base de datos
   de Monetiser. El conector recibe un **token** que genera el proveedor de
   campos del PSP en el navegador del comprador (en Paylands, el `source_uuid`
   de ProxyFields). Si el PSP nuevo no tiene campos alojados / tokenización en
   el navegador, **no se integra para tarjeta**.
2. **No inventar.** Cada endpoint, campo y estado sale de la documentación
   oficial del PSP, citada con su URL en un comentario. Lo que la doc no
   confirme va detrás de un flag apagado (`src/utils/featureFlags.js`) y se
   apunta en el DEV-LOG como "pendiente de verificar con <PSP>".
3. **Nunca reintentar en otro PSP tras pedir la tarjeta.** Un rechazo o un
   timeout no pasan al siguiente adquirente (doble cobro). El failover solo
   existe ANTES de mostrar los campos de tarjeta y lo decide el routing.
4. **Un timeout es un resultado desconocido**, no un rechazo: `status:'error'`
   con `error.code:'timeout'`.
5. **Nada de secretos en el repo** (es público). Las credenciales del PSP van
   en variables de entorno de Render (cuenta de plataforma) o cifradas en la
   cuenta del merchant (AES-256-GCM con `ENCRYPTION_KEY`).
6. **Conectores simulados nunca en producción** (`simulated` / `testOnly`).

---

## Paso a paso

### 1. Crear la carpeta del conector

```
src/connectors/<psp>/
  index.js      ← el conector según el contrato (defineConnector)
  client.js     ← cliente HTTP de bajo nivel del PSP (opcional, recomendado)
  webhook.js    ← verificación de firma + mapa de estados (si el PSP notifica)
```

### 2. Declarar capacidades con `defineConnector`

```js
const { defineConnector } = require('../contract');
const { makeError, fromHttpStatus } = require('../errors');

module.exports = defineConnector({
  id: 'miPsp',                       // estable: se guarda en Transaction.processor
  displayName: 'Mi PSP',
  capabilities: {
    paymentMethods: ['card'],        // de PAYMENT_METHODS (contract.js)
    currencies: ['EUR'],             // solo las que el PSP procesa DE VERDAD
    countries: ['*'],                // o lista ISO alfa-2
    deferredCapture: true, partialCapture: true,
    cancel: true, refund: true, partialRefund: true,
    threeDS: true, tokenization: true,
    webhooks: true, retrieve: false,
    perAccountCredentials: true,     // credenciales por merchant
    checkout: { fieldsProvider: 'mipsp_fields' },  // ver paso 6
    credentialFields: [
      { name: 'apiKey', secret: true, required: true },
      { name: 'webhookSecret', secret: true, required: true },
    ],
  },
  createPayment, capture, cancel, refund,
  verifyWebhook, parseWebhook, mapStatus, normalizeError,
});
```

`defineConnector` **lanza un error al arrancar** si el conector no cumple el
contrato (falta una operación obligatoria, declara `refund` sin implementarlo,
una divisa no es ISO…). Las operaciones que no implementes responden solas
`{ success:false, error:{ code:'not_supported' } }`.

### 3. Implementar las operaciones

Todas son `async (input, ctx)`. `ctx.credentials` trae las credenciales de la
cuenta del merchant **ya descifradas**. El conector no lee la base de datos ni
escribe credenciales en logs.

| Operación | Entrada | Debe devolver |
|---|---|---|
| `createPayment` | `{ paymentId, merchantId, amount, currency, method, sourceToken }` | `{ status, processorReference, action?, error? }` con `status` ∈ `requires_action` · `authorized` · `captured` · `pending` · `declined` · `error`. `requires_action` lleva `action: { type:'redirect', url }` (3DS). |
| `capture` | `{ processorReference, amount? }` | `{ success, status?, capturedTotal?, error? }` |
| `cancel` | `{ processorReference }` | `{ success, status?, error? }` |
| `refund` | `{ processorReference, amount? }` | `{ success, status?, refundedTotal?, error? }` |
| `retrieve` | `{ processorReference }` | `{ success, status (de Monetiser), rawStatus }` |
| `verifyWebhook` | `{ body, headers, rawBody }` | `true` / `false` (en tiempo constante) |
| `parseWebhook` | `body` | `{ processorReference, paymentId, rawStatus, status, amount }` |
| `mapStatus` | estado crudo del PSP | estado de Monetiser (`MONETISER_STATUSES`) o `null` si no lo conoce |
| `normalizeError` | lo que sea | `{ code, message, retryable }` con `code` de `src/connectors/errors.js` |

Importes siempre **enteros en céntimos**. Estados de Monetiser: los de
`src/utils/paymentStatus.js` (`cancelled` con dos L, como Paylands).

### 4. Pasar la suite de contrato

Crea `tests/contract/<psp>.contract.test.js` (copia
`tests/contract/connectorB.contract.test.js`), simulando la red del PSP con
`jest.mock('https')` o su SDK — **nunca** llamando al PSP de verdad:

```js
const { runConnectorContract } = require('./connectorContract');
runConnectorContract({ provider: require('../../src/connectors/miPsp'), harness: { ... } });
```

La suite comprueba resultados normalizados, que un fallo técnico nunca sale como
rechazo, mapa de estados, taxonomía de errores, firma de webhooks y que ningún
input/output tiene forma de PAN. Además añade un test **golden** del cable (como
`tests/golden/paylandsWire.test.js`) en cuanto el conector esté verificado
contra el PSP real.

### 5. Registrarlo

En `src/services/connectorRegistry.js`:

```js
const miPspProvider = require('../connectors/miPsp');
providers.miPsp = miPspProvider;
registry.miPsp  = legacyFromProvider(miPspProvider);   // lo que usa el ciclo de vida
```

Si el conector depende de credenciales que aún no existen, regístralo detrás de
un flag apagado. Al registrarse aparece solo en: el validador de políticas de
routing (`/admin` → Reglas), `GET /backoffice/connectors` y el routing.

### 6. Checkout (proveedor de campos)

El checkout (`/:merchantId/iframe`) pinta los campos del proveedor que declara
`capabilities.checkout.fieldsProvider` del conector enrutado. Para un PSP nuevo:

1. Añade un módulo de navegador en `public/checkout/providers/<id>.js` que
   registre `window.MonetiserCheckoutProviders['<id>'] = { mount(ctx), submit() }`
   (ver `public/checkout/providers/paylands_proxyfields.js`).
2. Añade sus dominios a la CSP del iFrame (`src/routes/iframe.js`,
   `CHECKOUT_PROVIDERS`).
3. Un endpoint de cobro propio que reciba **el token, nunca la tarjeta** (como
   `src/routes/proxyPciRoutes.js` para Paylands) y llame a
   `getProvider('<id>').createPayment(...)`.

Mientras no exista ese módulo, el routing **no** enruta checkouts a ese conector
(no tiene `fieldsProvider` disponible) y sigue usando Paylands.

### 7. Webhook entrante

Monta `POST /webhooks/<psp>` igual que `/webhooks/paynopain`
(`src/routes/webhooks.js`): verifica la firma ANTES de usar el body, montado
antes de los sanitizadores globales, máquina de estados
(`ACQUIRER_TRANSITIONS`) para que un aviso tardío no haga retroceder un pago, y
evento saliente solo si el estado cambió.

### 8. Cuenta del merchant

Desde `/admin` → Merchants → Adquirentes (o
`PUT /backoffice/merchants/:merchantId/connector-accounts/:connector`) se
guardan las credenciales del merchant para ese PSP, cifradas. Nunca se
devuelven en claro: la API enseña solo `••••` + últimos 4.

### 9. Documentar

- Entrada en el DEV-LOG: qué está verificado contra el PSP real y qué no.
- `openapi.yaml`: si cambia algo visible para el comercio (solo cambios aditivos).
- Runbook de pruebas en sandbox del PSP para Marcos.

---

## Lista de comprobación antes de abrir el PR

- [ ] Toda URL/campo del PSP citado con la URL de su documentación.
- [ ] `npx jest` verde, incluida su suite de contrato.
- [ ] Arranque real: `node -e "process.env.MONGO_URI='mongodb://127.0.0.1:27017/fake'; require('./index.js')"` sin warnings de montaje.
- [ ] `tests/golden/paylandsWire.test.js` sigue verde (Paylands no se ha tocado).
- [ ] Ningún log con token cobrable, PAN, CVV ni credencial.
- [ ] Lo no verificado, detrás de flag apagado y apuntado en el DEV-LOG.
