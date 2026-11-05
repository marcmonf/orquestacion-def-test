# Stripe como segundo PSP — runbook para Marcos (modo pruebas)

> Qué es: un comercio puede cobrar con **su propia cuenta Stripe** (de pruebas) a través de
> Monetiser. El comprador teclea la tarjeta **solo en el campo de Stripe** dentro del
> checkout de Monetiser (PCI SAQ A). Monetiser autoriza con **captura manual** (como el
> DEFERRED de Paylands) y luego se captura, anula o devuelve igual que con Paylands.
>
> **Aviso honesto:** desde la sesión que escribió esto **no se pudo abrir** ni
> docs.stripe.com, ni api.stripe.com, ni js.stripe.com (red bloqueada). El código se hizo con
> el SDK oficial `stripe-node` y el ejemplo oficial de Stripe `stripe-samples/accept-a-payment`,
> y se probó contra un Stripe **simulado**. **Nunca ha hablado con Stripe de verdad.** Este
> runbook es esa primera prueba real. Si un botón del panel de Stripe se llama distinto,
> busca el equivalente; si algo falla, apunta el mensaje exacto.

Todo en **modo de pruebas** de Stripe: no se mueve dinero real.

---

## 0. Antes: en Render (una vez)

1. Render → `orquestacion-def-test` → **Environment** → añadir:
   - `FEATURE_STRIPE` = `true`
   - (opcional, para probar dólares/libras) `SUPPORTED_CURRENCIES` = `EUR,USD,GBP`
2. **Manual Deploy → Deploy latest commit** (sin deploy no hay nada: push ≠ producción).
3. Comprobación: en el log de Render no debe salir `no montado` ni `MODULE_NOT_FOUND`.

## 1. Crear la cuenta Stripe de pruebas

1. Crea una cuenta en Stripe (stripe.com) con el email del comercio de demo. No hace falta
   activar pagos reales.
2. Asegúrate de estar en **modo de prueba** (interruptor "Test mode" / "Modo de prueba" del
   panel).

## 2. Copiar las dos claves

Panel de Stripe → **Developers / Desarrolladores → API keys**
(`https://dashboard.stripe.com/account/apikeys`, en modo prueba):

| Qué | Empieza por | Dónde se pega en Monetiser |
|---|---|---|
| Publishable key (clave publicable) | `pk_test_` | campo `publishableKey` |
| Secret key (clave secreta) — botón "Reveal" | `sk_test_` | campo `secretKey` |

La clave secreta **no** se manda por email ni chat: cópiala y pégala directamente en /admin.

## 3. Crear el endpoint de webhook y copiar su secreto

1. Monetiser: `https://orquestacion-def-test.onrender.com/admin` → **Merchants** → el
   comercio → botón **Adquirentes**. En la tarjeta **Stripe** sale la línea
   `URL del webhook: https://orquestacion-def-test.onrender.com/webhooks/stripe/<merchantId>`.
   Cópiala tal cual.
2. Panel de Stripe (modo prueba) → **Developers → Webhooks**
   (`https://dashboard.stripe.com/test/webhooks`) → **Add endpoint / Añadir destino**:
   - URL: la del punto 1.
   - Eventos (selecciona estos seis):
     `payment_intent.amount_capturable_updated`, `payment_intent.payment_failed`,
     `payment_intent.canceled`, `payment_intent.requires_action`,
     `payment_intent.succeeded`, `charge.refunded`.
3. Abre el endpoint creado → **Signing secret** → "Reveal" → empieza por `whsec_`. Ese es
   el `webhookSecret`.

## 4. Pegar todo en /admin

/admin → Merchants → el comercio → **Adquirentes** → tarjeta **Stripe**:

- `secretKey` = `sk_test_…`
- `publishableKey` = `pk_test_…`
- `webhookSecret` = `whsec_…`
- **Guardar credenciales de pruebas** → debe decir `Modo pruebas: CONFIGURADO (secretKey ••••XXXX …)`.

Si pegas una clave `sk_live_`/`pk_live_` la rechaza: en esta fase solo modo pruebas.

## 5. Routing de demostración

En la misma ventana: **Aplicar routing de demostración** → `Aplicado ✓`. Desde ese momento,
para ese comercio:

- divisa **EUR** y país del comprador **ES** → **Paylands**;
- todo lo demás → **Stripe**;
- si el elegido está caído (circuito abierto) o sin credenciales → el otro, **antes** de
  pedir la tarjeta.

Comprueba con **Simular routing**: `1000 · EUR · ES` → `Conector: payNoPain`;
`1000 · EUR · FR` → `Conector: stripe`.

## 6. Pago de prueba con Stripe (Postman web + navegador)

**Postman** → nueva petición:

- `POST https://orquestacion-def-test.onrender.com/v1/checkout-sessions`
- Headers:
  - `Authorization: Bearer ms_…` (clave API de pruebas del comercio, /admin → API Keys)
  - `Content-Type: application/json`
  - `Idempotency-Key: stripe-prueba-1` (cámbiala en cada intento)
- Body (raw, JSON):

```json
{ "amount": 1250, "currency": "EUR", "country": "FR", "reference": "PRUEBA-STRIPE-1" }
```

Resultado esperado: `201` con `"url": "https://…/hpp/…"` y `"paymentStatus": "hosted_pending"`.

**Navegador**: abre esa `url`. Debe salir el checkout de Monetiser con **Titular** y un
campo **Tarjeta** de Stripe (una sola línea: número, caducidad y CVC).

Tarjetas de prueba (las que publica el ejemplo oficial de Stripe; cualquier fecha futura,
cualquier CVC de 3 cifras y, si lo pide, cualquier código postal):

| Tarjeta | Resultado esperado |
|---|---|
| `4242 4242 4242 4242` (Visa) | Página "Pago completado". |
| `5555 5555 5555 4444` (Mastercard) | Igual. |
| `4000 0025 0000 3155` | Stripe muestra una ventana de **3D Secure** → "Complete/Completar" → "Pago completado". |

Para un **rechazo**: la tarjeta de rechazo de Stripe está en su página de tarjetas de
prueba (`https://stripe.com/docs/testing#cards`, enlazada desde su ejemplo oficial). No la
copiamos aquí porque no se pudo abrir esa página. Resultado esperado: "Pago no completado".

Después, en Postman:

- `GET https://orquestacion-def-test.onrender.com/v1/payments/<id>` (mismo `Authorization`)
  → `"status": "authorized"`.
- Panel de Stripe → **Payments** → el pago aparece como **No capturado / Uncaptured**.

## 7. Capturar, anular, devolver (igual que con Paylands)

Mismo `Authorization`, `Content-Type: application/json` y una `Idempotency-Key` nueva cada vez:

| Petición | Body | Esperado en Monetiser | En Stripe |
|---|---|---|---|
| `POST …/v1/payments/<id>/capture` | `{ "amount": 1000 }` | `status: partially_captured` | capturados 10,00; el resto se libera |
| `POST …/v1/payments/<id>/capture` | `{}` | `status: captured` | capturado entero |
| `POST …/v1/payments/<id>/cancel` | `{}` | `status: cancelled` (solo si NO estaba capturado) | Canceled |
| `POST …/v1/payments/<id>/refund` | `{ "amount": 500 }` | `status: partially_refunded` | reembolso parcial |
| `POST …/v1/payments/<id>/refund` | `{}` | `status: refunded` | reembolsado |

Igual que con Paylands: sobre un pago **autorizado sin capturar** solo caben capturar o
anular; un refund ahí falla (no hay dinero movido que devolver). **No es un bug.**
Con Stripe solo hay **una** captura por pago: tras una captura parcial, una segunda
captura falla (`capture.processor_declined`).

## 8. Comprobar el webhook

Panel de Stripe → Developers → Webhooks → tu endpoint → eventos enviados: todos en **200**.
Si salen **401**: el `webhookSecret` pegado no es el de ese endpoint. **409**: el comercio no
tiene la cuenta Stripe guardada en /admin. **404**: falta `FEATURE_STRIPE=true` + deploy.

Si el comercio tiene `webhookUrl`, recibe `payment.updated` con `"connectorUsed": "stripe"` y
el mismo formato y firma (`Monetiser-Signature`) que con Paylands.

## Si algo no funciona

1. ¿Se desplegó? (Manual Deploy después de poner `FEATURE_STRIPE`.)
2. Checkout en blanco o "Error al cargar el módulo de seguridad": abre la consola del
   navegador (F12). Si dice que la **Content Security Policy** bloqueó un dominio de Stripe,
   apúntalo: los dominios de la CSP de Stripe están **pendientes de verificar** (ver DEV-LOG).
3. Apunta el mensaje exacto y el `paymentId`.
