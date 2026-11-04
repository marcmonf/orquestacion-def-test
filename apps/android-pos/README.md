# Monetiser POS (Android)

App nativa (Kotlin, sin librerías externas) para cobrar **en tienda con QR** desde un
terminal Android (probado para los PAX A920Pro y A77 de pruebas de Marcos).

- Login con el **usuario del portal** del comercio, ligado a su tienda (rol Operador o
  Administrador). **Nunca** lleva la clave `ms_` del comercio.
- Teclado de importe + concepto → **QR grande** → el cliente paga en su móvil en el
  checkout de Monetiser → la app consulta el estado → **Pagado / Fallido / Caducado /
  Anulado**. Historial de hoy con el total.
- API que usa: `POST /portal/auth/login` y `/pos/*` (`src/routes/pos.js`).
- **No lee tarjetas ni imprime**: no hay SDK de PAX. Huecos en
  `app/src/main/java/com/monetiser/pos/hardware/` (pendiente del SDK).
- `minSdk 21` (Android 5.0), `targetSdk 34`.

Compilación: GitHub Actions (`.github/workflows/android-pos.yml`) genera el APK de debug
en cada push que toque `apps/android-pos/`. Instalación: `docs/runbook-sesion-5nov.md`
(sección POS).

En local (con Android SDK): `gradle -p apps/android-pos assembleDebug`.
