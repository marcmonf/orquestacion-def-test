# Runbook de pruebas — sesión del 5 nov 2026 (bloque 2): Stripe, escaparate, robustez

> Para Marcos. Solo **Postman web** y **navegador**.
> Antes de nada: fusionar el PR y **Manual Deploy** en Render de `main` (un commit en `main`
> NO está en producción hasta que lo despliegas).

Valores:
- `HOST` = `https://orquestacion-def-test.onrender.com`
- `SECRET` = tu clave de pruebas `ms_…` de un comercio de pruebas (la de la colección Postman).
- `MID` = el `merchantId` de ese comercio.
- `BO_TOKEN` = `token` de `POST HOST/backoffice/auth/login` (cuerpo
  `{ "email": "…", "password": "…", "totp": "123456" }`, `totp` solo si tienes 2FA).
- `PORTAL_TOKEN` = `token` de `POST HOST/portal/auth/login` (cuerpo `{ "email": "…", "password": "…" }`)
  de un usuario **administrador** del portal de ese comercio.

En Postman: colección **Monetiser — API v1** → variables `host`, `secret`, `merchantId`,
`adminToken` (= BO_TOKEN), `portalToken` (= PORTAL_TOKEN). Carpeta **14** = esta sesión.

---

## 0. Variables en Render (una vez) → Manual Deploy

| Variable | Valor | Para qué |
|---|---|---|
| `FEATURE_STRIPE` | `true` | Activa Stripe como segundo PSP (apagado si no la pones). |
| `MONETISER_ENV` | `sandbox` | Ya debería estar (docs/entornos.md §1). Sin ella `/demo` responde 404. |
| `DEMO_STORE_SECRET` | una clave `ms_test_…` NUEVA de un comercio de demo (ver §3) | El "servidor" de la tienda demo. Nunca la pegues en ningún otro sitio. |
| `SUPPORTED_CURRENCIES` | `EUR,USD,GBP` (opcional) | Solo si quieres probar pagos en dólares/libras con Stripe. |

Después: **Manual Deploy → Deploy latest commit**. En el log no debe salir `no montado`.

## 1. Lo de siempre sigue igual (5 min)

1. Postman → **1. Crear sesión de pago** → 201. Abre la `url` → checkout de **Paylands** de
   siempre (número, mes, año, CVV, titular). Paga con `4018810000100036` · `12/34` · `123` →
   "Pago completado".
2. **4. Capturar** → 200 `captured`. Es el ciclo verificado; si algo de aquí falla, para y avisa.

## 2. Stripe (detalle en `docs/stripe.md`)

Sigue `docs/stripe.md` de principio a fin: cuenta de pruebas de Stripe, claves `pk_test_` /
`sk_test_`, endpoint de webhook con su `whsec_`, pegarlos en **/admin → Merchants → el
comercio → Adquirentes**, **Aplicar routing de demostración**, y:

| Paso | Dónde | Esperado |
|---|---|---|
| Simular `1000 · EUR · ES` | /admin → Adquirentes → Simular | `Conector: payNoPain · motivo: rule` |
| Simular `1000 · EUR · FR` | igual | `Conector: stripe · motivo: default` |
| 14.4 Crear sesión (FR) | Postman | 201; la `url` enseña **Titular** + campo **Tarjeta** de Stripe |
| Pagar `4242 4242 4242 4242`, fecha futura, CVC `123` | navegador | "Pago completado" |
| **3. Consultar el pago** | Postman | `status: authorized` |
| **4. Capturar** con `{ "amount": 1000 }` | Postman | `partially_captured`; en Stripe: capturado 10,00 € |
| **5. Devolver** `{ "amount": 500 }` | Postman | `partially_refunded` |
| Pagar otra sesión FR con `4000 0025 0000 3155` | navegador | ventana 3DS de Stripe → "Complete" → "Pago completado" |
| Panel Stripe → Webhooks → tu endpoint | Stripe | eventos en **200** |

Si el checkout de Stripe sale en blanco o con "Error al cargar el módulo de seguridad":
F12 → consola → si pone "Content Security Policy" con un dominio de Stripe, apúntalo y avisa
(los dominios de la CSP de Stripe están pendientes de verificar).

## 3. Tienda demo `/demo`

1. /admin → Merchants → **+ Nuevo merchant**: id `alfar-brisa`, nombre **Alfar Brisa**,
   país ES (marca inventada: no uses nombres reales). → **API Keys** → nueva key → copia el
   `rawSecret` (empieza por `ms_`; de pruebas).
2. Render → `DEMO_STORE_SECRET` = ese secreto → Manual Deploy.
3. (Opcional) Ese comercio → Adquirentes → su cuenta Stripe de pruebas + routing de demo.
4. Navegador: `HOST/demo` → catálogo de 4 piezas → añade 2 "Taza Marea" + 1 "Jarra Bruma"
   → Total **68,00 €** → País **ES** → **Pagar con tarjeta** → aparece el checkout dentro de
   la página con 68.00 EUR → paga con la tarjeta de Paylands → "Pago completado". Debajo:
   `Pedido BRISA-… · estado authorized · adquirente payNoPain`.
5. Con País **FR** (y Stripe configurado) el checkout es el de Stripe.
6. **Crear enlace de pago y QR** → sale el enlace `HOST/pay/pl_…` y un QR. Escanéalo con el
   móvil → checkout → paga.
7. Comprobación de seguridad: botón derecho → "Ver código fuente": **no** aparece la clave `ms_`.

## 4. Documentación para desarrolladores

`HOST/developers` → guía de integración completa + "Endpoints de la API v1 y ejemplos" con
curl / Node.js / PHP desplegables + enlace a la referencia (`/docs`).

## 5. Insights de orquestación

- /admin → pestaña **Orquestación** → Ver → tasa de aprobación, pagos, % con 3DS, volumen,
  **comparativa por PSP** (payNoPain / stripe), motivos de rechazo y por qué se enrutó cada pago.
- Portal (usuario administrador) → pestaña **Orquestación** → lo mismo, solo su comercio.
- Postman 14.5 / 14.6 → 200 con `insights`.
- Ojo: los pagos anteriores a este despliegue no tienen el dato de 3DS ni el motivo del
  rechazo (salen "sin 3DS" y "motivo no informado").

## 6. Si algo falla

1. ¿Se desplegó después de cambiar las variables?
2. Apunta el mensaje exacto, el `paymentId` y la hora.
