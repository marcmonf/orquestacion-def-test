// src/utils/runtimeSecrets.js
'use strict';
//
// Resolución de secretos de firma (JWT) con política FAIL-CLOSED.
//
// Antes, si BACKOFFICE_JWT_SECRET o PORTAL_JWT_SECRET no estaban definidos, el
// código usaba un valor de desarrollo escrito en este repositorio PÚBLICO
// ('dev_backoffice_secret_change_me', 'dev_portal_secret_change_me'). En ese
// caso cualquiera podía fabricar un token de superadmin y entrar al backoffice.
//
// Ahora el valor de desarrollo SOLO se usa si NODE_ENV es explícitamente
// 'development' o 'test'. En cualquier otro caso (incluido NODE_ENV sin definir,
// que es lo habitual en Render) el secreto es obligatorio: sin él, el plano
// correspondiente responde 503 y no emite ni acepta tokens. El resto de la
// aplicación (pagos, iFrame, webhooks) sigue funcionando.

const DEV_ENVS = ['development', 'test'];

function isDevOrTest() {
  return DEV_ENVS.includes(String(process.env.NODE_ENV || '').toLowerCase());
}

function resolveSecret(envName, devFallback) {
  const value = process.env[envName];
  if (value) return value;
  return isDevOrTest() ? devFallback : null;
}

module.exports = { isDevOrTest, resolveSecret };
