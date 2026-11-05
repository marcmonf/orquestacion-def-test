# Dos entornos: pruebas (sandbox) y producción — runbook para Marcos

> Monetiser corre en **dos despliegues separados**. Cada uno con su servicio en
> Render, su base de datos en Atlas, sus credenciales de Paylands y sus secretos.
> Nunca comparten nada: así un error en pruebas no puede tocar dinero real.
>
> **Aviso honesto:** desde la sesión que escribió esto no se pudieron abrir las webs de
> Render ni de Atlas. Los pasos usan los nombres de menú habituales; si un botón se llama
> distinto, busca el equivalente. Lo que es código (variables, comprobaciones, página de
> estado) sí está hecho y probado.

| | Pruebas (lo que hay hoy) | Producción (nuevo) |
|---|---|---|
| Servicio Render | `orquestacion-def-test` (el actual) | uno NUEVO, p. ej. `monetiser-production` |
| Rama que despliega | `main` | `main` (mismo código) |
| `MONETISER_ENV` | `sandbox` | `production` |
| `PAYNOPAIN_ENV` | `sandbox` | `production` |
| Base de datos (Atlas) | la actual | proyecto/cluster NUEVO (recomendado) o, como mínimo, otra base y otro usuario |
| Credenciales Paylands | las de sandbox | las reales (cuando PayNoPain las entregue) |
| Secretos (`ADMIN_TOKEN`, JWT, `HPP_SIGNING_SECRET`, `CREDENTIALS_ENCRYPTION_KEY`, `WEBHOOK_SECRET`) | los actuales | **todos nuevos y distintos** |

El código comprueba la coherencia: si `MONETISER_ENV` no casa con `PAYNOPAIN_ENV`, o si en
producción la `MONGO_URI` parece de pruebas (contiene `test`, `sandbox` o `staging`), sale
`⚠️ [CONFIG] ENTORNO INCOHERENTE` al arrancar, `/health/ready` responde 503 y el checklist
(`GET /backoffice/production-readiness`) lo marca como bloqueante.

---

## 1. Ya mismo: marcar el entorno actual como pruebas

Render → `orquestacion-def-test` → **Environment** → añadir `MONETISER_ENV` = `sandbox` →
Manual Deploy. Comprueba `https://orquestacion-def-test.onrender.com/health` → debe incluir
`"environment": "sandbox"`.

## 2. Base de datos de producción en Atlas

1. Atlas → **Create** un **proyecto nuevo** llamado `monetiser-production` y dentro un
   **cluster** nuevo. Para dinero real elige un plan **con copias de seguridad en la nube**
   (los planes gratuitos/compartidos no tienen las mismas copias: comprueba en la pantalla
   del plan que pone "Backup"/"Cloud Backup").
2. **Database Access** → **Add New Database User**: usuario `monetiser_prod`, contraseña
   generada (guárdala en tu gestor), rol "Read and write to any database" (o solo a la base
   `monetiser`).
3. **Network Access**: permite las IPs de salida de Render (o `0.0.0.0/0` si tu plan de
   Render no tiene IPs fijas — es lo que se usa hoy; la contraseña es la protección).
4. **Connect** → **Drivers** → copia la cadena `mongodb+srv://…`, sustituye `<password>` y
   añade el nombre de base `/monetiser` antes del `?`. Esa es la `MONGO_URI` de producción.
   **No** debe contener las palabras `test`, `sandbox` ni `staging`.

## 3. Servicio de producción en Render

1. Render → **New +** → **Web Service** → conecta el repositorio
   `marcmonf/orquestacion-def-test`, rama `main`.
2. Mismos comandos que el servicio actual (míralos en su pestaña **Settings**): build
   `npm install` (o el que tenga), start `npm start`.
3. **Auto-Deploy: No** (igual que el actual: todo despliegue es manual).
4. **Health Check Path**: `/health` (no `/health/ready`: con un corte breve de Atlas,
   Render reiniciaría el servicio en bucle).
5. **Environment**: copia la lista de `docs/produccion.md` §1 con valores NUEVOS, más:
   `MONETISER_ENV=production`, `PAYNOPAIN_ENV=production`, la `MONGO_URI` del paso 2,
   `SERVER_URL=https://<url del servicio nuevo>`, `ALERT_EMAILS=<tu email>` y los `SMTP_*`.
6. **Manual Deploy**. En el log: ningún `⚠️ [CONFIG]` ni `⚠️ [PRODUCCIÓN]`.
7. Comprobaciones (navegador):
   - `https://<servicio nuevo>/health` → `"environment": "production"`, `"db": "up"`.
   - `https://<servicio nuevo>/health/ready` → `{"ready": true, …}`.
   - `https://<servicio nuevo>/status` → "Todos los sistemas operativos", entorno Producción.
8. Crear el primer superadmin de producción:
   `POST https://<servicio nuevo>/backoffice/auth/setup` con `X-Admin-Token: <ADMIN_TOKEN de
   producción>` (mismo procedimiento que se usó en pruebas) y activar su **2FA** en /admin.
9. En Paylands (cuando lo tengas): la URL de notificación del servicio real es
   `https://<servicio nuevo>/webhooks/paynopain` (Monetiser la manda en cada orden).

## 4. Alertas por email

En cada servicio: `ALERT_EMAILS=<tu email>[,otro]` + `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`,
`SMTP_PASS`, `SMTP_FROM` (los de Google Workspace que ya usa la facturación). Llegan
correos "[Monetiser production] ALERTA: …" cuando:

- el circuito de un adquirente se abre (está fallando);
- hay webhooks a comercios atascados (> 15 min vencidos) o > 20 fallidos en 1 h;
- hay > 10 errores técnicos del adquirente en 15 min (los rechazos del banco no cuentan).

Y un "RESUELTA" cuando se arregla. Ajustes opcionales: `ALERT_WEBHOOK_STUCK_MS`,
`ALERT_WEBHOOK_FAILED_HOUR`, `ALERT_ACQUIRER_ERRORS_15M`, `ALERT_REPEAT_MS`,
`ALERT_INTERVAL_MS`.

## 5. Página de estado pública

`https://<servicio>/status` (y `/status.json`). Enseña: API y checkout, base de datos,
webhooks a comercios y cada adquirente. Sin datos de comercios ni de pagos. Se puede
enlazar desde la web de Monetiser.

## 6. Copias de seguridad (Atlas)

**Producción:**
1. Atlas → proyecto `monetiser-production` → cluster → **Backup** → activar **Cloud
   Backup** (si el plan lo ofrece) con la política por defecto o: instantánea cada 6 h,
   diarias 7 días, semanales 4 semanas, mensuales 12 meses. Para facturas (obligación
   legal de conservarlas), la copia mensual y la exportación del punto 3 son clave.
2. Si el plan permite **Continuous Cloud Backup / Point in Time**, actívalo: permite volver
   a un minuto concreto (útil ante un borrado por error).
3. Además, **una vez al mes**: /admin → Facturación → exportar CSV del mes cerrado y
   guardarlo fuera de Atlas (Drive de la empresa).

**Prueba de restauración (cada 3 meses, 15 min):** Atlas → Backup → elegir una
instantánea → **Restore** → **a otro cluster** (nunca sobre producción) → conectar con
Compass o el Data Explorer de Atlas y comprobar que están las colecciones `transactions`,
`merchants`, `invoices`. Apunta la fecha de la prueba en el DEV-LOG.

**Qué hacer si hay que restaurar producción de verdad:** 1) poner Render en mantenimiento
(Suspend del servicio), 2) restaurar la instantánea a un cluster nuevo, 3) cambiar
`MONGO_URI` del servicio a ese cluster, 4) Manual Deploy, 5) revisar en Paylands los pagos
entre la hora de la copia y el corte (los webhooks de Paylands que llegaron en ese hueco se
perdieron: se reconcilian a mano con el panel de Paylands).

**Pruebas (sandbox):** basta con la copia que ofrezca su plan; no hay dinero real.
