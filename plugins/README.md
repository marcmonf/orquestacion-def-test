# Plugins de tienda de Monetiser

Tres plugins para cobrar con Monetiser desde una tienda online, todos sobre la **API v1**
(`Authorization: Bearer ms_…`). El comprador paga **siempre en el checkout de Monetiser**:
la tienda nunca ve la tarjeta (PCI DSS SAQ A). Los avisos de pago llegan por **webhook
firmado** (`Monetiser-Signature`), que el plugin verifica y además **vuelve a consultar el
pago** en Monetiser antes de dar el pedido por pagado. Las devoluciones se hacen desde el
admin de la tienda.

| Carpeta | Plataforma | Estado |
|---|---|---|
| `woocommerce/monetiser-for-woocommerce/` | WordPress + WooCommerce | Lint PHP ✅ · tests de lógica con stubs ✅ · **sin probar en una instalación real** |
| `prestashop/monetiser/` | PrestaShop 8 | Lint PHP ✅ · **sin probar en una instalación real** |
| `magento/Monetiser_Payment/` | Magento 2 / Adobe Commerce | Lint PHP/XML/JS ✅ · **sin probar en una instalación real** |
| — | Shopify | **No hay plugin** (ver abajo) |

`_core/MonetiserClient.php` es el núcleo común (cliente de la API v1 + verificación de
firma). Cada plugin lleva una **copia idéntica** (los tests comprueban que no se desvían).

**Por qué "sin probar en una instalación real":** desde el contenedor donde se escribieron
no se podía descargar WordPress, PrestaShop ni Magento (sus webs y descargas estaban
bloqueadas por la red), ni abrir su documentación. Se usó como referencia el **código fuente
oficial** de cada plataforma en GitHub (enlazado en la cabecera de cada plugin). Hay que
probarlos en una tienda de pruebas antes de dárselos a un comercio.

Tests: `php plugins/tests/run.php`.

## Antes de instalar cualquiera (en Monetiser)

1. /admin → Merchants → el comercio → **API Keys** → crear → copiar el **secreto `ms_…`**
   (se enseña una vez).
2. /admin → Merchants → el comercio → **Secreto webhook** → copiar el `whsec_…`.
3. Servidor: `https://orquestacion-def-test.onrender.com` (pruebas) o el de producción.

## WooCommerce

1. Comprime la carpeta `woocommerce/monetiser-for-woocommerce/` en un `.zip`.
2. WordPress → Plugins → Añadir nuevo → **Subir plugin** → el `.zip` → Activar.
3. WooCommerce → Ajustes → **Pagos** → Monetiser → Activar y rellenar: servidor, clave
   `ms_…`, secreto `whsec_…`, modo (pantalla completa o embebido), captura automática (sí).
4. La URL de webhook es `https://TU-TIENDA/wp-json/monetiser/v1/webhook` (sale en los
   ajustes). Monetiser la recibe en cada pago: no hay que configurarla en Monetiser.
5. Prueba: compra algo → pagar con `4018810000100036` · `12/34` · `123` → el pedido pasa a
   **Procesando** con una nota "Monetiser: pago cobrado". Pedido → **Reembolso** → importe →
   "Reembolsar vía Monetiser" → nota "devolución hecha".
6. Requisito: permalinks "bonitos" activados (para `/wp-json/`).

**Nota:** está hecho para el checkout **clásico** de WooCommerce. El checkout por
**bloques** necesita registrar el método también en la API de bloques: pendiente (sin
documentación accesible para hacerlo sin inventar).

## PrestaShop 8

1. Comprime la carpeta `prestashop/monetiser/` en `monetiser.zip` (la carpeta dentro del zip
   se tiene que llamar `monetiser`).
2. Back office → Módulos → **Subir un módulo** → el zip → Configurar.
3. Rellenar servidor, clave `ms_…` y secreto `whsec_…` → Guardar. La URL de webhook sale en
   la pantalla (`…/module/monetiser/webhook`).
4. Prueba: comprar → elegir "Tarjeta (pago seguro con Monetiser)" → pagar → vuelve a la
   confirmación del pedido (estado "Pago aceptado"). Devolución: pedido → **Devolución
   parcial** (vale de devolución) → Monetiser devuelve ese importe.

## Magento 2 / Adobe Commerce

1. Copia `magento/Monetiser_Payment/` a `app/code/Monetiser/Payment/` en la instalación.
2. En el servidor de Magento:
   ```bash
   bin/magento module:enable Monetiser_Payment
   ```
   ```bash
   bin/magento setup:upgrade
   ```
   ```bash
   bin/magento setup:di:compile
   ```
   ```bash
   bin/magento cache:flush
   ```
3. Admin → Tiendas → Configuración → Ventas → **Métodos de pago** → Monetiser → activar,
   servidor, clave `ms_…`, secreto `whsec_…`.
4. Prueba: comprar → "Realizar pedido" → checkout de Monetiser → pagar → el pedido pasa de
   "Pendiente de pago" a facturado. Devolución: factura → **Nota de crédito** (online).

**Nota:** usa `AbstractMethod`, que Adobe marca como obsoleto en favor del "payment gateway
framework" (aunque los métodos de pago del propio Magento lo siguen usando). Migrarlo:
DECISIÓN PENDIENTE.

## Shopify — por qué NO hay plugin

Se pidió comprobar primero en **shopify.dev** qué exige Shopify a una pasarela de pago
externa. **No se pudo abrir shopify.dev** desde el contenedor (bloqueado por la red), así
que no hay nada verificado. Lo que se sabe de forma general (**NO verificado en la fuente**,
a confirmar): las pasarelas de pago de terceros en Shopify se integran como **"payments
apps"** y para publicarlas hay que ser **socio de pagos aprobado por Shopify** (proceso de
solicitud y revisión). Siguiendo la instrucción —si exige aprobación como partner, no
escribir plugin— **no se ha escrito nada**.

Camino propuesto (DECISIÓN PENDIENTE DE MARCOS):
1. Abrir `https://shopify.dev/docs/apps/build/payments` y sus "requirements" y confirmar
   qué piden hoy (alta como Shopify Partner, solicitud de payments app, requisitos de
   empresa, PCI, revisión).
2. Si encaja, darse de alta como Shopify Partner y presentar la solicitud.
3. Mientras tanto, un comercio Shopify puede usar los **enlaces de pago de Monetiser**
   (F3 de esta sesión) para cobros sueltos (no como checkout integrado).
