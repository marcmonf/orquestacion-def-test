# Redsys directo (TPV Virtual del comercio) — runbook para Marcos (pruebas)

> Qué es: un comercio cobra con **su propio TPV Virtual de Redsys** (el de su banco) a través
> de Monetiser, sin pasar por Paylands. El comprador teclea la tarjeta **en la página de
> Redsys** (redirección, PCI SAQ A). Monetiser pide una **preautorización** (tipo 1) y recibe
> el resultado por la **notificación online** firmada.
>
> **Aviso honesto:** desde la sesión que escribió esto no se pudo abrir ninguna web de Redsys
> (canales.redsys.es, pagosonline.redsys.es, sis-t.redsys.es). Todo sale de los datos del
> manual de redirección que verificaste tú, y se probó contra un Redsys **simulado**. Este
> runbook es la primera prueba real. Si algo falla, apunta el código exacto (p. ej. `SIS0042`).

Todo en el **entorno de pruebas** de Redsys: no se mueve dinero real.

## 0. Render (una vez)

1. Render → `orquestacion-def-test` → **Environment**:
   - `FEATURE_REDSYS` = `true`
   - `SERVER_URL` = `https://orquestacion-def-test.onrender.com` (ya debería estar: es la base
     de la URL de notificación y de vuelta que Monetiser manda a Redsys).
   - **NO** pongas `FEATURE_REDSYS_OPERATIONS` (ver §6: su formato actual es incorrecto).
2. **Manual Deploy → Deploy latest commit**. En el log no debe salir `no montado`.

## 1. Datos del TPV de pruebas

Del **manual de integración por redirección** de Redsys (apartado del entorno de pruebas;
`https://canales.redsys.es/ayuda/documentacion/`), o de los que te dé el banco del comercio:

| Dato del manual | Campo en Monetiser |
|---|---|
| Número de comercio (FUC, 9 cifras) | `merchantCode` |
| Terminal | `terminal` |
| Clave de firma SHA-256 (texto Base64) | `secretKey` |

Estos valores **no** se escriben en el repositorio ni en ningún sitio público (el repo es
público): solo se pegan en /admin.

## 2. Pegarlos en /admin

`https://orquestacion-def-test.onrender.com/admin` → **Merchants** → el comercio de pruebas →
**Adquirentes** → tarjeta **Redsys (TPV Virtual del comercio)**:
- `merchantCode`, `terminal`, `secretKey` → **Guardar credenciales de pruebas** → debe decir
  `Modo pruebas: CONFIGURADO (merchantCode … · terminal … · secretKey ••••XXXX)`.
- La línea **URL de notificación** es la que Monetiser manda a Redsys en cada pago
  (`…/webhooks/redsys/<merchantId>`); no hay que pegarla en Redsys.

## 3. Routing

En la misma ventana: **Routing de demostración** → `EUR + ES →` **Redsys**, `resto →`
**Paylands** → **Aplicar** → `Aplicado ✓`. **Simular** `1000 · EUR · ES` → `Conector: redsys`.

## 4. Pago en el entorno de pruebas de Redsys (Postman web + navegador)

Postman → colección → carpeta **15** → **15.3 Crear sesión que va a Redsys** (o a mano):

- `POST https://orquestacion-def-test.onrender.com/v1/checkout-sessions`
- Headers: `Authorization: Bearer ms_…` · `Content-Type: application/json` · `Idempotency-Key: redsys-prueba-1`
- Body: `{ "amount": 1250, "currency": "EUR", "country": "ES", "reference": "PRUEBA-REDSYS-1" }`
- Esperado: `201` con `url`.

Navegador → abre la `url`:
1. Checkout de Monetiser con el importe y el texto "irás a la página segura de pago de tu
   banco (Redsys)" → **Pagar ahora**.
2. La ventana entera va a la página de pago de Redsys (entorno de pruebas). Usa la **tarjeta
   de prueba que trae el manual** de Redsys (no se copia aquí: no se pudo abrir el manual) y
   completa la autenticación de prueba si la pide.
3. Redsys te devuelve a la página de resultado de Monetiser: **"Pago completado"**.

Si en vez de la página de pago Redsys muestra un error:
- `SIS0042` (firma): avisa. El modo del 3DES (CBC, vector de ceros, relleno con ceros) no lo
  especifica la documentación de Redsys ni trae un ejemplo válido: esta prueba es la que lo
  confirma.
- `SIS0051` (pedido repetido): crea otra sesión y repite.

## 5. Comprobar la notificación

- Postman **15.4 Consultar el pago** → `"status": "authorized"` (si sale `pending_3ds`, la
  notificación aún no ha llegado: espera unos segundos y repite).
- Panel de Redsys del comercio (Canales / administración del TPV de pruebas): la operación
  aparece como **preautorización autorizada**.
- Si nunca pasa a `authorized`: en el log de Render busca `WEBHOOK_REDSYS_`
  (`INVALID_SIGNATURE` = la clave pegada no es la del TPV; `NOT_CONFIGURED` = falta guardar el
  TPV en /admin). Comprueba también en la configuración del TPV de Redsys que la notificación
  online (HTTP) esté activada.

## 6. Capturar, anular, devolver

**Hoy, con Redsys, desde Monetiser están APAGADOS.** Ya sabemos cuál es el canal de Redsys
para operaciones sin titular (confirmación 2, anulación 9, devolución 3): el **Web Service
XML** del Manual Web Service, método `trataPeticion`
(`https://sis-t.redsys.es:25443/sis/services/SerClsWSEntrada` en pruebas). Lo que hay hoy en
el código para eso es **incorrecto** (JSON) y se rehace en la próxima sesión.

- Postman **15.5 Capturar** → esperado HOY `502` con `"detail": "not_supported"`. **No es un
  bug.**
- Confirmar, anular o devolver: desde el **panel de Redsys** del comercio. La notificación de
  esas operaciones deja traza en Monetiser pero no cambia el estado del pago (decisión
  pendiente en el DEV-LOG).
- **No pongas `FEATURE_REDSYS_OPERATIONS` en Render**: con el formato actual no funcionaría.
  Se activará cuando esté rehecho contra el Web Service XML (próxima sesión).
