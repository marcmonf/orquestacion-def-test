# M3 — Especificación del Dashboard (visión de producto)

> Documento de trabajo creado con Marcos (11 julio 2026) para guiar la construcción
> del dashboard en M3. Recoge QUÉ debe hacer el dashboard. El orden de construcción
> se decide al arrancar M3. La estética actual (estilo Claude, oscuro) se mantiene —
> a Marcos le gusta como está.

## Base actual (ya existe y funciona)
- Login por email+contraseña (`/backoffice/auth/login`, modelo BackofficeUser con roles).
- Analíticas/KPIs, timeline, países, métodos.
- Lista y detalle de transacciones, con refund (verificado) y cancel.
- Gestión de usuarios del backoffice.
- Servido en `/admin` (dashboard.html).

---

## 1. Comercios (merchants) — [confirmado]
CRUD completo: crear, listar, editar, suspender.
- Conecta con las rutas de M2 (modelo Merchant unificado).
- Decisión de arquitectura (de M2): exponer merchants bajo `/backoffice` (mismo login
  del dashboard), reutilizando el modelo Merchant. Mantener `/merchants` con X-Admin-Token
  (M2) intacto como segunda puerta.
- Ver, por comercio: campos operativos (plan, status, webhookUrl), su config Paylands
  (serviceUuid/templateUuid), su branding, y sus transacciones.

## 2. API keys — [confirmado]
Crear, revocar, listar por comercio.
- Mostrar la key completa SOLO al crearla (después, solo prefijo/hash).
- Idealmente: fecha de creación y de último uso.

## 3. Transacciones — [MEJORA CLAVE pedida por Marcos]
**Widgets expandibles con detalle.** Hoy los widgets muestran datos pero al pinchar no
se abren a una vista de lista/detalle. Marcos quiere que **al pinchar un widget (ej.
Transacciones), se expanda a una vista ampliada con la lista detallada.** Patrón general:
widget = resumen; clic = vista completa con detalle.
- Filtros: por comercio, fecha, importe, estado.
- Detalle de cada transacción: incluir info del 3DS y los webhooks asociados a esa tx.
- (Posible) exportar a CSV.

## 4. Webhooks — [Marcos no lo tiene claro, DECIDIR en M3]
Marcos: "no sé, esto me pierdo". Propuesta a validar cuando lleguemos:
- Ver webhooks entrantes (de Paylands) y salientes (a comercios).
- Ver por qué falló uno y poder reintentarlo.
- Puede que esto viva mejor DENTRO del detalle de cada transacción (punto 3) que como
  sección propia. Decidir con Marcos al construirlo.

## 5. Analíticas / KPIs — [confirmado + ampliado]
Además de las actuales (volumen, tasa aprobación, ticket medio, timeline, países, métodos):
- **Chargebacks recibidos** y sus **motivos** (Paylands TIENE API de chargebacks:
  list, get, dispute — factible integrar cuando lleguemos).
- **Región/país** de origen del pago.
- **Tipo de medio de pago** usado: Visa, Mastercard, Bizum, MB Way, etc.
- Métricas de negocio: volumen por comercio, tasa de aprobación, tasa de 3DS,
  (a futuro) ingresos por comisión.

## 6. Editor de routing — [VISIÓN GRANDE — construir por capas]
Marcos quiere un editor de routing "que vuele la cabeza": supervisual, interactivo,
usable por un gestor de ecommerce sin perfil técnico. Estilo "unir nodos": conectar
un tipo de tarjeta con un procesador/adquirente, y que el sistema informe del impacto
esperado (ej. "esta combinación → bajada esperada del X% en tasa de aceptación").

**Realismo por capas (importante, no vender humo):**
- CAPA 1 (construible): el editor visual interactivo — nodos, conexiones, arrastrar,
  reglas por BIN/tarjeta/importe/país → adquirente. El backend de reglas de routing
  YA existe (routingRules, el editor viejo en /admin/index.html).
- CAPA 2 (FUTURO, requiere datos): la predicción de impacto en tasa de aceptación.
  Necesita datos históricos de aceptación por combinación tarjeta/adquirente. HOY no
  hay datos (solo un adquirente: Paylands, y poco volumen). Esta capa cobra sentido
  cuando: (a) haya varios adquirentes integrados, y (b) haya volumen histórico real.
  Hasta entonces, cualquier "predicción" sería inventada.
- Nota: hoy el orquestador solo apunta a Paylands. El editor multi-adquirente es
  plenamente útil cuando se integren más adquirentes.

## 7. Facturación / billing — [confirmado, es M8 en el roadmap]
Marcos lo quiere ver asomar en el dashboard. Alinear con el milestone M8 (billing).

## 8. Cuenta / configuración / usuarios — [confirmado]
- Superuser que puede crear y ajustar usuarios, roles, permisos.
- El modelo BackofficeUser ya tiene roles (MANAGER/USER/VIEWER...) y merchantScope.
- Falta la UI de gestión de roles/permisos por encima de la gestión de usuarios actual.

## 9. Estética / UX — [confirmado: NO tocar]
La estética actual le gusta a Marcos ("muy Claude style", oscuro). Mantener.
El trabajo de M3 es FUNCIONALIDAD, no rediseño visual.

---

## Orden sugerido de construcción (a confirmar al arrancar M3)
Prioridad por valor operativo inmediato:
1. Comercios (1) + API keys (2) — lo que falta para operar el negocio. Conecta con M2.
2. Transacciones: widgets expandibles con detalle (3) — mejora de uso muy pedida.
3. Analíticas ampliadas (5): medio de pago, región, chargebacks.
4. Usuarios/roles superuser (8).
5. Webhooks (4) — decidir si sección propia o dentro del detalle de tx.
6. Editor de routing capa 1 (6) — visual/interactivo.
7. Billing (7) — cuando se aborde M8.
8. Editor de routing capa 2 (predicción) — cuando haya varios adquirentes y datos.
