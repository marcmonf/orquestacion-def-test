// src/utils/checkoutProviders.js
'use strict';
//
// PROVEEDORES DE CAMPOS DEL CHECKOUT (framework multi-PSP, nov 2026).
//
// El checkout de Monetiser (/:merchantId/iframe) no pinta NUNCA un campo de
// tarjeta propio (PCI SAQ A): pinta los campos alojados del PSP al que se
// enrutó el pago. Cada proveedor de campos declara aquí:
//   - script:  su módulo de navegador (public/checkout/providers/<id>.js),
//              servido con ruta ABSOLUTA (el iFrame vive en /:merchantId/iframe,
//              sin barra final: una ruta relativa resolvería mal — CLAUDE.md).
//   - csp:     los dominios que necesita (se añaden a la CSP del iFrame).
//   - runtime: datos extra que el módulo necesita (p. ej. la URL de su librería).
//
// Hoy: ProxyFields de Paylands y Stripe Elements. Añadir otro: docs/conectores.md §6.

// URL de la librería cliente ProxyFields según el entorno de Paylands.
// PAYNOPAIN_PCI_CLIENT_URL permite fijarla a mano. El valor por defecto de
// producción replica la ruta /prod que usa el servidor (pciProxyService.js) y
// DEBE confirmarse con Paylands antes de salir a producción.
function pciClientUrl() {
  if (process.env.PAYNOPAIN_PCI_CLIENT_URL) return process.env.PAYNOPAIN_PCI_CLIENT_URL;
  return process.env.PAYNOPAIN_ENV === 'production'
    ? 'https://pci-proxy-api.paynopain.com/prod/client.js'
    : 'https://pci-proxy-api.paynopain.com/sandbox/client.js';
}

const PROVIDERS = Object.freeze({
  paylands_proxyfields: Object.freeze({
    id: 'paylands_proxyfields',
    connector: 'payNoPain',
    script: '/checkout/providers/paylands_proxyfields.js',
    // Mismos dominios que tenía la CSP del iFrame antes del framework:
    // - pci-proxy-api.paynopain.com: librería ProxyFields + fetch al Proxy PCI
    // - pci-proxy-sandbox.paynopain.com: sub-iFrame del campo PAN
    // - api.paylands.com: 3DS tokenizado (navega dentro del iFrame) y formularios
    csp: Object.freeze({
      script:  ['https://pci-proxy-api.paynopain.com'],
      connect: ['https://pci-proxy-api.paynopain.com'],
      frame:   ['https://pci-proxy-api.paynopain.com', 'https://pci-proxy-sandbox.paynopain.com', 'https://api.paylands.com'],
      form:    ['https://api.paylands.com'],
    }),
    runtime: () => ({ pciClientUrl: pciClientUrl() }),
  }),
  // Stripe Elements (sesión 5 nov 2026, F1). La tarjeta solo se teclea en el
  // campo alojado de Stripe (iFrame de Stripe): PCI SAQ A.
  // URL de Stripe.js: la que usa el cargador oficial @stripe/stripe-js 10.1.0
  // (ORIGIN https://js.stripe.com + release train 'endive', el mismo que la
  // versión de API del SDK de servidor 2026-09-30.endive).
  // Dominios de la CSP: PENDIENTES DE VERIFICAR con la documentación de Stripe
  // (docs.stripe.com bloqueado desde el contenedor). js.stripe.com (script y
  // campos), api.stripe.com (confirmación desde el navegador) y
  // hooks.stripe.com (ventana del 3DS). Si la consola del navegador muestra un
  // bloqueo de CSP con otro dominio de Stripe, añadirlo aquí.
  stripe_elements: Object.freeze({
    id: 'stripe_elements',
    connector: 'stripe',
    script: '/checkout/providers/stripe_elements.js',
    csp: Object.freeze({
      script:  ['https://js.stripe.com'],
      connect: ['https://api.stripe.com'],
      frame:   ['https://js.stripe.com', 'https://hooks.stripe.com'],
      form:    [],
    }),
    runtime: () => ({ stripeJsUrl: 'https://js.stripe.com/endive/stripe.js' }),
  }),
});

const DEFAULT_FIELDS_PROVIDER = 'paylands_proxyfields';

// Métodos de pago que el checkout sabe presentar HOY. Un conector puede
// declarar más (F5, detrás de flags), pero mientras su flujo de navegador no
// exista y esté verificado, el checkout no los ofrece.
const CHECKOUT_METHOD_UI = Object.freeze(['card']);

function getFieldsProvider(id) {
  return PROVIDERS[id] || null;
}

function buildCsp(provider) {
  const p = provider.csp;
  const list = (arr) => (arr.length ? ' ' + arr.join(' ') : '');
  return "default-src 'self'; " +
    "img-src 'self' data: https:; " +
    "style-src 'self' 'unsafe-inline'; " +
    `script-src 'self' 'unsafe-inline'${list(p.script)}; ` +
    `connect-src 'self'${list(p.connect)}; ` +
    `frame-src 'self'${list(p.frame)}; ` +
    `form-action 'self'${list(p.form)}; ` +
    "base-uri 'none'; object-src 'none'; " +
    'frame-ancestors *;';
}

module.exports = { PROVIDERS, DEFAULT_FIELDS_PROVIDER, CHECKOUT_METHOD_UI, getFieldsProvider, buildCsp, pciClientUrl };
