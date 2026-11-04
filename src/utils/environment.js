// src/utils/environment.js
'use strict';
//
// ENTORNO de este despliegue (nov 2026, F2 "producción de verdad").
//
// Monetiser corre en DOS despliegues separados en Render, cada uno con su base
// de datos en Atlas y sus credenciales de Paylands:
//   MONETISER_ENV=sandbox     → pruebas (Paylands sandbox, tarjetas de prueba)
//   MONETISER_ENV=production  → dinero real (Paylands producción)
// Sin la variable se asume 'sandbox' (lo que es hoy el servidor existente).
//
// La variable no cambia comportamiento por sí sola: sirve para (a) decir en la
// página de estado, /health y /admin en qué entorno se está, y (b) detectar
// mezclas peligrosas (p. ej. MONETISER_ENV=production con Paylands sandbox, o
// al revés), que se avisan al arrancar y bloquean el checklist de producción.

function name() {
  const v = String(process.env.MONETISER_ENV || 'sandbox').trim().toLowerCase();
  return v === 'production' ? 'production' : 'sandbox';
}

function isProduction() { return name() === 'production'; }

// Incoherencias entre MONETISER_ENV y el resto de la configuración.
function mismatches() {
  const out = [];
  const env = name();
  const pnp = process.env.PAYNOPAIN_ENV || 'sandbox';
  if (env === 'production' && pnp !== 'production') out.push('MONETISER_ENV=production pero PAYNOPAIN_ENV no es production (cobraría contra el sandbox de Paylands)');
  if (env === 'sandbox' && pnp === 'production') out.push('MONETISER_ENV=sandbox pero PAYNOPAIN_ENV=production (un entorno de pruebas moviendo dinero real)');
  if (env === 'production' && /test|sandbox|staging/i.test(String(process.env.MONGO_URI || '').replace(/^mongodb(\+srv)?:\/\/[^@]*@/, ''))) {
    out.push('MONETISER_ENV=production y MONGO_URI parece de pruebas (contiene test/sandbox/staging)');
  }
  return out;
}

module.exports = { name, isProduction, mismatches };
