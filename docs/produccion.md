# Pasar Monetiser a dinero real — checklist

> Para Marcos. Todo se hace en **Render → servicio → Environment** y después
> **Manual Deploy → Deploy latest commit** (en este proyecto NO hay auto-deploy).
> Ningún valor de esta lista se escribe nunca en el repositorio (es público).

## 0. Cómo comprobarlo sin adivinar

Hay un endpoint que revisa la configuración del servidor y dice qué falta, **sin
enseñar ningún secreto**:

```
GET https://orquestacion-def-test.onrender.com/backoffice/production-readiness
Authorization: Bearer <token de /backoffice/auth/login de un superadmin>
```

Respuesta: `readyForProduction` (`true`/`false`), `blockers` (cuántos faltan) y
`items` (cada variable con `ok` y qué hacer). Además, cuando `PAYNOPAIN_ENV=production`,
cada fallo sale al arrancar en el log de Render como `⚠️ [PRODUCCIÓN] …`.

## 1. Bloqueantes (sin esto, NO se pasa a real)

| Variable | Valor en real | Por qué |
|---|---|---|
| `PAYNOPAIN_ENV` | `production` | Cambia los endpoints de Paylands y del Proxy PCI a producción. **Solo cuando PayNoPain entregue las credenciales reales.** |
| `PAYNOPAIN_API_KEY`, `PAYNOPAIN_SIGNATURE`, `PAYNOPAIN_SERVICE_UUID` | los de la cuenta **real** | Los de sandbox no funcionan en producción. |
| `PAYNOPAIN_PCI_CLIENT_URL` | la URL de ProxyFields de producción que **confirme Paylands** | El valor por defecto (`…/prod/client.js`) es una suposición nuestra, no está verificado. |
| `API_KEY_SIMPLE_FALLBACK` | `false` (o borrarla) | Con `true`, la API antigua acepta el secreto en una cabecera sin firma. En real: la API antigua solo con HMAC; los comercios nuevos usan `/v1` (Bearer). |
| `ALLOW_DUMMY_CONNECTOR` | **borrarla** | Activa el simulador que aprueba todo sin cobrar. |
| `NODE_ENV` | `production` o sin definir (nunca `development`/`test`) | `development`/`test` activan valores de desarrollo y el simulador. |
| `ADMIN_TOKEN` | ≥ 32 caracteres aleatorios | Protege la recuperación de cuentas (`reset-password`, `reset-2fa`). |
| `BACKOFFICE_JWT_SECRET`, `PORTAL_JWT_SECRET` | dos valores aleatorios **distintos** | Si fuesen iguales, un token del portal valdría en /admin. |
| `HPP_SIGNING_SECRET` | 64 hex aleatorios | Firma la URL del iFrame y la vuelta del comprador. |
| `CREDENTIALS_ENCRYPTION_KEY` | 64 hex aleatorios | Cifra credenciales de PSP por merchant, secretos 2FA y tokens de tarjeta guardada. **No cambiarla nunca después**: lo cifrado con la anterior deja de poder abrirse (habría que volver a guardar credenciales y reactivar 2FA). |
| `SERVER_URL` | `https://<dominio de producción>` | Paylands notifica a `SERVER_URL/webhooks/paynopain` y devuelve al comprador a `SERVER_URL/checkout/result/...`. |
| `BACKOFFICE_2FA_REQUIRED` | `true` | **Después** de que cada superadmin haya activado su 2FA (/admin → botón **2FA**). Con `true`, un superadmin sin 2FA solo puede entrar a activarla. |

Para generar valores aleatorios de 64 hex (en el ordenador de Marcos, terminal):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Importante: en producción solo se cobra en modo LIVE (desde el 5 nov 2026)

Con `PAYNOPAIN_ENV=production`, Monetiser **solo** manda a Paylands pagos de modo live:
hace falta `FEATURE_LIVEMODE=true` y que cada comercio use una clave **`ms_live_…`**
(/admin → Merchants → API Keys, casilla live / `{"livemode": true}`) con la **API v1**.
Las claves de pruebas (`ms_test_…` y las `ms_…` antiguas) y la API antigua
(`/{merchantId}/payments/...`) **no cobran** en ese despliegue (responden
`no_connector_available` / `mode_mismatch`): así un pago de pruebas nunca toca dinero
real. Es la consecuencia del hallazgo H1 de la revisión del 5 nov (DEV-LOG).

## 2. Recomendadas

| Variable | Valor | Por qué |
|---|---|---|
| `WEBHOOK_SECRET` | ≥ 32 caracteres | Respaldo para firmar webhooks de merchants sin secreto propio. |
| `ALLOWED_ORIGINS` | orígenes del panel y del portal | CORS cerrado. |
| `DOCS_ENABLED` | decidir | `false` oculta `/docs` y `/openapi.yaml`. |
| `MONGO_URI` | base de datos **separada** de la de pruebas | Mezclar pagos reales y de prueba complica facturación y analíticas. Ver decisión pendiente "entorno de producción separado" en el DEV-LOG. |

## 3. Deben seguir APAGADOS (hasta verificarlos con PayNoPain)

`FEATURE_LIVEMODE`, `FEATURE_SAVED_CARDS`, `FEATURE_PAYLANDS_BIZUM`,
`FEATURE_PAYLANDS_APPLE_PAY`, `FEATURE_PAYLANDS_GOOGLE_PAY`. Ver DEV-LOG, sesión del
4 nov 2026.

## 4. Antes del primer pago real

1. Revocar la API key de demo-merchant que estuvo publicada (DEV-LOG §7).
2. Rellenar los datos fiscales de la Sociedad y de cada comercio (/admin).
3. Un pago real de importe mínimo con una tarjeta propia → capturar → reembolsar.
4. Confirmar en el log de Render que no sale ningún `⚠️ [PRODUCCIÓN]` ni `⚠️ [CONFIG]`.

## 5. Rotar la clave de cifrado (`CREDENTIALS_ENCRYPTION_KEY`)

Lo cifrado (credenciales de adquirentes, secretos 2FA, tokens de tarjeta guardada)
lleva dentro con qué clave se cifró. Se puede cambiar de clave **sin perder nada**:

1. Genera una clave nueva (64 hex) con el comando del punto 1 y guárdala en tu gestor
   de contraseñas.
2. Render → Environment. **No borres** `CREDENTIALS_ENCRYPTION_KEY`. Añade:
   - `CREDENTIALS_KEYS` = `k2026b:<la clave nueva>`
     (formato `nombre:64hex`; varias separadas por coma; el nombre es libre, sin `:`).
   - `CREDENTIALS_KEY_ACTIVE` = `k2026b`
3. Manual Deploy. Desde ese momento lo NUEVO se cifra con `k2026b`; lo antiguo se sigue
   abriendo con `CREDENTIALS_ENCRYPTION_KEY`.
4. Postman, con el token de superadmin (`POST /backoffice/auth/login`):
   - `GET  HOST/backoffice/security/encryption-status` → `byKey` muestra cuántos hay con
     `legacy` (la antigua) y cuántos con `k2026b`.
   - `POST HOST/backoffice/security/reencrypt` con cuerpo `{ "dryRun": true }` → simulación:
     `failed` debe ser `0`.
   - `POST HOST/backoffice/security/reencrypt` con cuerpo `{ "dryRun": false }` → recifra.
   - `GET  HOST/backoffice/security/encryption-status` otra vez → `pendingReencrypt: 0`.
5. Solo entonces, y si quieres retirar la antigua: borra `CREDENTIALS_ENCRYPTION_KEY`
   **y** `ENCRYPTION_KEY` si existe (Manual Deploy). Si algo saliese con `failed > 0`, NO
   la borres: avisa.

Para la siguiente rotación: `CREDENTIALS_KEYS` = `k2026b:<…>,k2027a:<nueva>` y
`CREDENTIALS_KEY_ACTIVE=k2027a`, y repetir 3–5 (quitando `k2026b` al final).
