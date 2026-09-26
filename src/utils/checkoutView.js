// src/utils/checkoutView.js
'use strict';
//
// Utilidades compartidas por las PÁGINAS que ve el comprador (iFrame de pago y
// página de resultado): escapado de datos incrustados en HTML, saneado del
// branding que edita un operador y páginas de error con marca.
//
// Todo lo que acaba dentro del HTML sale de aquí: si un día cambia la regla de
// escapado, cambia para todas las páginas a la vez.

const fs   = require('fs');
const path = require('path');

// Solo se aceptan colores CSS hexadecimales: el valor acaba en una propiedad CSS
// y lo edita un operador; nada de expresiones arbitrarias.
function safeColor(value, fallback) {
  return /^#[0-9a-fA-F]{3,8}$/.test(String(value || '')) ? value : fallback;
}

// Logo: solo https (o ruta propia absoluta). Nunca javascript:, data:, etc.
function safeLogoUrl(value) {
  const v = String(value || '');
  if (/^https:\/\/[^\s"'<>]+$/i.test(v)) return v;
  if (/^\/[A-Za-z0-9._\-/]+$/.test(v)) return v;
  return '/Logo_Monetiser.png';
}

// JSON seguro para incrustar dentro de <script>: sin "<" literal no se puede
// cerrar la etiqueta (</script>) ni abrir comentarios HTML.
function jsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function readHtml(abs) {
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

function publicFile(relative) {
  return path.join(__dirname, '../../public', relative);
}

const ERROR_PAGES = {
  400: '400.html',
  403: '403.html',
  404: '404.html',
  409: '409.html',
  410: '410.html',
  429: '429.html',
  500: '500.html',
};

function brandedError(res, code) {
  const html = readHtml(publicFile(path.join('errors', ERROR_PAGES[code] || '403.html')));
  return res.status(code).send(html || String(code));
}

// Branding del merchant para las páginas del comprador (campos anidados nuevos
// con fallback a los planos legados), ya saneado.
function merchantBranding(merchant, fallbackName) {
  const m = merchant || {};
  const b = m.branding || {};
  return {
    logoUrl:      safeLogoUrl(b.logoUrl || m.logoUrl),
    brandColor:   safeColor(b.primaryColor || m.brandColor, '#0070f3'),
    accentColor:  safeColor(b.accentColor || m.accentColor, '#0053b3'),
    merchantName: String(b.merchantName || m.name || fallbackName || ''),
  };
}

module.exports = {
  safeColor,
  safeLogoUrl,
  jsonForScript,
  readHtml,
  publicFile,
  brandedError,
  merchantBranding,
};
