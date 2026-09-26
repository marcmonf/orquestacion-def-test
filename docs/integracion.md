# Integrar Monetiser en tu tienda — API v1

Guía para el equipo técnico del comercio. Con ella se cobra con tarjeta en unos 30
minutos de trabajo. Contrato completo: `openapi.yaml` (o `/docs` en el servidor).

Servidor de pruebas (sandbox de Paylands): `https://orquestacion-def-test.onrender.com`
En los ejemplos se escribe `$MONETISER`.

## Cómo funciona, en tres piezas

1. **Tu servidor** crea una *sesión de pago*: una llamada, recibe una `url`.
2. **Tu web** muestra el checkout de esa `url`, embebido o a pantalla completa.
3. **Tu servidor** recibe el webhook firmado y da el pedido por pagado.

**Tu web nunca ve la tarjeta.** El comprador la escribe en campos de Paylands que
van dentro del checkout de Monetiser. Así tu comercio queda en **PCI DSS SAQ A**, el
cuestionario más sencillo. La API rechaza cualquier dato de tarjeta
(`400 card_data_not_accepted`).

## Antes de empezar

En `/admin`, con un usuario de Monetiser:

- **API key**: Merchants → tu comercio → *API Keys* → crear. Guarda el **secreto**
  (`ms_...`): solo se muestra una vez. El identificador `mk_...` no sirve para
  autenticar.
- **Secreto de webhooks** (`whsec_...`): se muestra al dar de alta el comercio. Si no
  lo tienes, pulsa *Secreto webhook* para generar uno nuevo.
- **URL de webhooks** (opcional): en la ficha del comercio. Se usa cuando la sesión no
  indica una propia.

> El secreto `ms_...` va **solo en tu servidor**, nunca en el navegador ni en una app.
> La API no admite llamadas desde webs (no tiene CORS): si lo intentas desde el
> frontend, el navegador la bloquea.

## 1. Crear la sesión (en tu servidor)

```bash
curl -X POST "$MONETISER/v1/checkout-sessions" \
  -H "Authorization: Bearer ms_TU_SECRETO" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: pedido-1234-intento-1" \
  -d '{
    "amount": 4999,
    "currency": "EUR",
    "reference": "PEDIDO-1234",
    "returnUrl": "https://tutienda.com/pedido/1234/gracias",
    "webhookUrl": "https://tutienda.com/webhooks/monetiser"
  }'
```

Respuesta `201`:

```json
{
  "id": "c0ff4727-852c-4695-939c-10203f88d385",
  "object": "checkout_session",
  "status": "open",
  "result": "pending",
  "paymentStatus": "hosted_pending",
  "amount": 4999,
  "currency": "EUR",
  "reference": "PEDIDO-1234",
  "url": "https://orquestacion-def-test.onrender.com/hpp/64827020-fd45-44f9-af40-acadaf05e8b2",
  "returnUrl": "https://tutienda.com/pedido/1234/gracias",
  "webhookUrl": "https://tutienda.com/webhooks/monetiser",
  "expiresAt": "2026-09-26T20:04:35.455Z",
  "createdAt": "2026-09-26T19:34:35.455Z"
}
```

| Campo | Obligatorio | Qué es |
|---|---|---|
| `amount` | sí | Importe en **céntimos**, número entero (`4999` = 49,99 €). |
| `currency` | sí | `EUR` (por ahora la única). |
| `reference` | no | Tu número de pedido. Vuelve en el webhook como `merchantReference`. |
| `returnUrl` | no | A dónde vuelve el comprador al terminar (`http` o `https`). |
| `webhookUrl` | no | A dónde te avisamos (solo `https`). Si no la mandas, la de tu ficha. |

- Guarda el `id`: identifica el pago en el webhook, en las consultas y en
  capturar/devolver.
- La sesión caduca a los **30 minutos** (`expiresAt`).
- **Idempotency-Key** (recomendada): si repites la petición con la misma clave (por un
  timeout, por ejemplo), recibes **la misma sesión** con un `200` y no se crea otro
  pago. Si reutilizas la clave con otros datos, recibes `409 idempotency_key_reused`.

En Node:

```js
const res = await fetch(`${process.env.MONETISER}/v1/checkout-sessions`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${process.env.MONETISER_SECRET}`,
    'Content-Type': 'application/json',
    'Idempotency-Key': `pedido-${order.id}`,
  },
  body: JSON.stringify({ amount: order.totalCents, currency: 'EUR', reference: order.id, returnUrl }),
});
const session = await res.json();   // session.url → a tu web
```

## 2. Mostrar el checkout (en tu web)

### Opción A — embebido en tu página (recomendada)

```html
<div id="checkout"></div>
<script src="https://orquestacion-def-test.onrender.com/v1/monetiser.js"></script>
<script>
  Monetiser.mount('#checkout', {
    url: 'URL_DE_LA_SESION',                  // session.url, que te pasa tu servidor
    onResult: function (r) {
      // r.paymentId, r.status y r.result: 'succeeded' | 'failed' | 'pending'
      // Solo sirve para la pantalla. El pedido se confirma en tu servidor (paso 3).
      if (r.result === 'succeeded') window.location = '/pedido/1234/gracias';
    }
  });
</script>
```

El comprador paga dentro del recuadro, 3DS del banco incluido. Al terminar ve el
resultado ahí mismo y tu página recibe `onResult`.

Si tu web usa **Content-Security-Policy**, añade `script-src` para
`https://orquestacion-def-test.onrender.com` y `frame-src https:`. El 3DS navega
dentro del recuadro a Paylands y al banco, y la CSP de tu página también manda sobre
lo que pasa dentro de sus iFrames.

### Opción B — a pantalla completa

Redirige al comprador a `session.url`. Al terminar vuelve a tu `returnUrl` con dos
parámetros añadidos:

```
https://tutienda.com/pedido/1234/gracias?paymentId=c0ff4727-…&result=succeeded
```

Estos parámetros solo sirven para la pantalla: cualquiera puede escribirlos a mano.

## 3. Confirmar el pago (en tu servidor)

### Webhook (recomendado)

Monetiser hace un `POST` a tu `webhookUrl` cada vez que cambia el estado del pago:

```http
POST /webhooks/monetiser
Content-Type: application/json
Monetiser-Event-Id: evt_66f5c0…
Monetiser-Signature: t=1790530000, v1=5f2c…

{
  "id": "evt_66f5c0…",
  "event": "payment.updated",
  "version": "v1",
  "data": {
    "paymentId": "c0ff4727-852c-4695-939c-10203f88d385",
    "merchantReference": "PEDIDO-1234",
    "status": "authorized",
    "amount": 4999,
    "currency": "EUR",
    "timestamp": "2026-09-26T19:36:10.000Z"
  }
}
```

| `event` | Cuándo |
|---|---|
| `payment.updated` | El banco resolvió el pago: `status` = `authorized` (aprobado), `declined`, … |
| `payment.captured` | Capturaste (se cobró de verdad). |
| `payment.refunded` | Devolviste todo o parte. |
| `payment.cancelled` | Anulaste una autorización (se liberó la retención). |

**Verifica siempre la firma.** Es un HMAC-SHA256 con tu secreto `whsec_...` sobre
`<t>.<cuerpo tal cual llega>`. En Node con Express:

```js
const crypto = require('crypto');

app.post('/webhooks/monetiser', express.raw({ type: 'application/json' }), (req, res) => {
  const raw = req.body.toString('utf8');                        // cuerpo SIN reinterpretar
  const header = req.get('Monetiser-Signature') || '';
  const t = (header.match(/t=(\d+)/) || [])[1];
  const v1 = (header.match(/v1=([0-9a-f]{64})/) || [])[1];
  if (!t || !v1) return res.sendStatus(400);
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return res.sendStatus(400);   // más de 5 min: se rechaza (repetición)

  const expected = crypto.createHmac('sha256', process.env.MONETISER_WEBHOOK_SECRET)
    .update(`${t}.${raw}`, 'utf8').digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1))) return res.sendStatus(400);

  const evt = JSON.parse(raw);
  // Deduplica por evt.id (los reintentos llevan el mismo id) y actualiza tu pedido:
  //   evt.data.merchantReference → tu pedido; evt.data.status → su estado.
  res.sendStatus(200);                                          // responde rápido (2xx)
});
```

Si tu servidor no responde `2xx`, Monetiser reintenta durante unos 2 días: al cabo de
1 min, 5 min, 15 min, 1 h, 3 h, 6 h, 12 h y 24 h. Los reintentos llevan el mismo `id`.

### O consulta el pago

```bash
curl "$MONETISER/v1/payments/c0ff4727-852c-4695-939c-10203f88d385" \
  -H "Authorization: Bearer ms_TU_SECRETO"
```

Devuelve `status`, `result`, `capturedAmount`, `refundedAmount` y la tarjeta
truncada (marca, últimos 4 dígitos y país), que puedes enseñar al cliente.

## 4. Cobrar, devolver y anular

Un pago aprobado queda **`authorized`**: el banco **retiene** el dinero pero todavía
no lo cobra. Para cobrarlo, **captúralo**. La retención no dura para siempre:
confirma el plazo con Paylands.

```bash
# Cobrar: total, o una parte con {"amount": 2000}
curl -X POST "$MONETISER/v1/payments/<id>/capture" -H "Authorization: Bearer ms_TU_SECRETO" \
  -H "Content-Type: application/json" -H "Idempotency-Key: cap-pedido-1234" -d '{}'

# Devolver lo cobrado: total, o una parte con {"amount": 1000}
curl -X POST "$MONETISER/v1/payments/<id>/refund" -H "Authorization: Bearer ms_TU_SECRETO" \
  -H "Content-Type: application/json" -H "Idempotency-Key: ref-pedido-1234-1" -d '{"amount": 1000}'

# Anular una autorización SIN capturar (libera la retención)
curl -X POST "$MONETISER/v1/payments/<id>/cancel" -H "Authorization: Bearer ms_TU_SECRETO" \
  -H "Content-Type: application/json" -H "Idempotency-Key: can-pedido-1234" -d '{}'
```

- Cada llamada devuelve el pago actualizado.
- Una devolución exige captura previa. Sobre un pago sin capturar se usa `cancel`:
  si pides un `refund` recibes `409 capture_required`.
- Manda una `Idempotency-Key` distinta por operación. Si repites una llamada con la
  misma clave, no se repite la operación.

## Estados

`result`: el resultado en una palabra. Es el mismo en la API, en `onResult` y en la
vuelta a tu web.

| `result` | Significa |
|---|---|
| `pending` | Aún sin resultado (el comprador no ha pagado o el banco no ha contestado). |
| `succeeded` | El banco aprobó el pago. Mira `status` para saber si ya está capturado. |
| `failed` | No se cobró: rechazado, anulado, caducado o error. |

`status` (del pago): `hosted_pending` → `processing` → `pending_3ds` → `authorized`
→ `captured` / `partially_captured` → `refunded` / `partially_refunded`. También
puede acabar en `declined`, `cancelled` o `error`.

`status` de la sesión: `open`, `processing`, `complete` o `expired`.

## Errores

Todas las respuestas de error tienen la misma forma:
`{ "success": false, "error": "<código>", "message": "…" }`.

| HTTP | `error` | Qué hacer |
|---|---|---|
| 400 | `validation_error` | Revisa `details` (importe entero ≥ 1, divisa, URLs). |
| 400 | `card_data_not_accepted` | No mandes datos de tarjeta: los escribe el comprador en el checkout. |
| 401 | `unauthorized` | Cabecera `Authorization: Bearer ms_...` ausente, errónea o key revocada. |
| 403 | `merchant_suspended` | Tu comercio está suspendido: contacta con Monetiser. |
| 404 | `not_found` | Ese pago no existe o no es tuyo. |
| 409 | `idempotency_key_reused` | Misma Idempotency-Key con datos distintos. |
| 409 | `invalid_status`, `capture_required`, `already_captured`, `amount_too_large` | La operación no cabe en el estado actual del pago. |
| 409 | `payment_busy`, `operation_in_progress` | Hay otra operación en curso sobre ese pago: reintenta en unos segundos. |
| 429 | `rate_limit_exceeded` | Demasiadas peticiones: espera y reintenta. |
| 502 | `processor_declined` | Paylands o el banco rechazaron la operación. |

## Probar en sandbox

Tarjeta de prueba: `4018810000100036`, caducidad `12/34`, CVV `123`. Completa el 3DS
de prueba.

Para ver el checkout y el aviso `onResult` sin programar nada, usa
`$MONETISER/test-checkout.html`: pega la `url` de una sesión y pulsa *Cargar*.

## Resumen de lo que NO hay que hacer

- Poner el secreto `ms_...` en el navegador o en una app.
- Dar un pedido por pagado por `onResult` o por los parámetros de la `returnUrl`: se
  confirma con el webhook firmado o con `GET /v1/payments/:id`.
- Mandar datos de tarjeta a la API.
- Olvidar capturar: un pago `authorized` no está cobrado.
