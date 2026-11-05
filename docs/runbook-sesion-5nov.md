# Runbook de pruebas — sesión del 5 nov 2026

> Para Marcos. Solo **Postman web**, **navegador** y, para la app, el **PAX por USB**.
> Antes de nada: **Manual Deploy** en Render de `main` cuando esté fusionado el PR (un
> commit en `main` NO está en producción hasta que lo despliegas).

Valores:
- `HOST` = `https://orquestacion-def-test.onrender.com`
- `SECRET` = tu clave de pruebas `ms_…` de demo-merchant (la de la colección Postman).
- `BO_TOKEN` = `token` de `POST HOST/backoffice/auth/login` (cuerpo `{ "email": "…", "password": "…" }`;
  desde esta versión, si tienes 2FA, añade `"totp": "123456"`).

---

## A. Lo nuevo de seguridad (revisión del PR #4)

**A1. 2FA pide contraseña.** `/admin` → botón **2FA** → "Activar 2FA" sin escribir la
contraseña → "Escribe tu contraseña". Con la contraseña → sale la clave → código de la app
→ "ACTIVADA". Sigues dentro (tu sesión se renueva); cualquier OTRA sesión tuya abierta se
cierra.

**A2. Estado del cifrado (Postman).**
`GET HOST/backoffice/security/encryption-status` · `Authorization: Bearer BO_TOKEN`
→ 200 con `activeKey: "legacy"` y `pendingReencrypt: 0` (no hay rotación configurada).
Rotar la clave: `docs/produccion.md` §5.

**A3. El portal no ve las credenciales.** Portal → Adquirentes → la ficha de Paylands no
enseña nada cifrado.

## B. Producción de verdad

**B1.** Navegador: `HOST/health` → incluye `"environment": "sandbox"` (cuando hayas añadido
`MONETISER_ENV=sandbox` en Render, `docs/entornos.md` §1).
**B2.** Navegador: `HOST/health/ready` → `{"ready": true, …}`.
**B3.** Navegador: `HOST/status` → "Todos los sistemas operativos" (o qué falla).
**B4.** Alertas: Render → Environment → `ALERT_EMAILS=<tu email>` (con los `SMTP_*` de la
facturación) → Manual Deploy. Recibirás un email si algo se rompe (no hay forma segura de
provocarlo a mano en producción: se probó con tests).
**B5.** Segundo entorno (producción) y copias de Atlas: `docs/entornos.md` (paso a paso).

## C. Enlaces de pago + QR (prueba real en sandbox)

**C1. Crear (Postman).**
`POST HOST/v1/payment-links` · `Authorization: Bearer SECRET` · `Content-Type: application/json`
```json
{ "amount": 1250, "currency": "EUR", "concept": "Prueba enlace de pago", "reference": "ENLACE-1" }
```
→ **201** con `id` (`pl_…`), `url`, `qrUrl`, `status: "active"`, `reusable: false`.

**C2. Pagar (móvil o navegador).** Abre la `url` → página con el logo y "Prueba enlace de
pago · 12.50 EUR" → **Pagar** → checkout de siempre → `4018810000100036` · `12/34` · `123`
→ 3DS → "Pago completado". Abre `qrUrl` en el ordenador y escanéalo con el móvil: lleva a
la misma página.

**C3. Comprobar.** `GET HOST/v1/payment-links/<id>` → `status: "completed"`, `paidCount: 1`.
El pago (`GET HOST/v1/payments/<paymentId del webhook o del portal>`) es un pago normal:
captura/devolución como siempre. Volver a abrir la `url` → "Este enlace de pago ya se ha
pagado".

**C4. Anular.** Crea otro (C1) → `POST HOST/v1/payment-links/<id>/cancel` → `status:
"cancelled"`; la `url` → "ya no está disponible".

**C5. Portal y /admin.** Portal (`HOST/portal-app`) → pestaña **Enlaces de pago** →
crear 12,50 € → sale con su QR → botón Anular. `/admin` → pestaña **Enlaces de pago** →
los ves todos y puedes anular.

## D. App Android "Monetiser POS" en los PAX (A920Pro y A77)

**D0. Preparar el usuario de la tienda (portal, una vez).** Portal → **Jerarquía**: crea la
tienda (p. ej. "Tienda Centro"). Portal → **Usuarios**: crea un usuario **Operador** y
asígnale esa tienda. Entra una vez en `HOST/portal-app` con él para cambiar la contraseña
temporal.

**D1. Descargar el APK.**
1. GitHub → repositorio `marcmonf/orquestacion-def-test` → pestaña **Actions**.
2. A la izquierda, **Android POS (APK debug)** → la ejecución más reciente en verde.
3. Abajo, **Artifacts** → `monetiser-pos-debug-apk` → se descarga un `.zip`. Descomprímelo:
   dentro está `app-debug.apk`. (El artefacto caduca a los 30 días; cualquier push que toque
   `apps/android-pos/` genera otro.)

**D2. Instalar por USB.**
1. En el PAX: **Ajustes → Acerca del dispositivo** → toca 7 veces "Número de compilación"
   para activar **Opciones de desarrollador** → dentro, activa **Depuración USB**. (Son
   terminales de DEBUG: si el menú se llama distinto, busca "Depuración USB".)
2. En tu ordenador instala **Android Platform Tools** (incluye `adb`) desde la web oficial
   de Android para desarrolladores.
3. Conecta el PAX por USB → en el PAX acepta "¿Permitir depuración USB?".
4. En un terminal, en la carpeta del APK:
   ```bash
   adb devices
   ```
   Debe salir el terminal como `device`. Luego:
   ```bash
   adb install -r app-debug.apk
   ```
   → `Success`. La app aparece como **Monetiser POS**.

**D3. Probar.**
1. Abre la app → email y contraseña del usuario de D0 (servidor por defecto: el de pruebas).
   Esperado: entra y arriba pone "Comercio · Tienda Centro" y "MODO PRUEBAS".
   (Si sale "no está ligado a ninguna tienda": falta D0.)
2. Teclea **1250** (= 12,50 €), concepto "Prueba POS" → **Cobrar con QR** → QR grande.
3. Escanéalo con tu móvil → paga con la tarjeta de prueba y el 3DS → en el PAX, en unos
   segundos: pantalla verde **Pagado**.
4. Otro cobro → no lo pagues → **Anular cobro** → **Anulado**. Otro → déjalo 15 min →
   **Caducado**. Otro → paga con una tarjeta que el sandbox rechace (si tienes una) →
   **Fallido**.
5. **Cobros de hoy** → la lista y el total cobrado.
6. "Imprimir ticket" sale desactivado: **pendiente del SDK de PAX** (no lo tenemos). La app
   tampoco lee tarjetas.

## E. Plugins de tienda

Ver `plugins/README.md` (instalación en una tienda de pruebas de WooCommerce, PrestaShop
y Magento, y por qué no hay plugin de Shopify).
