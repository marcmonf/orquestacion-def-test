// src/utils/hppSigner.js
'use strict';
//
// Firma de la URL del iFrame de pago (GET /hpp/:id → 302 → /:merchantId/iframe?...&signature=).
//
// Antes la firma se hacía con el signingSecret del merchant y, si el merchant no
// tenía (caso de TODOS los merchants dados de alta desde /admin), con la cadena
// literal 'default_merchant_secret' — escrita en este repo público. Con eso
// cualquiera podía fabricar URLs de iFrame válidas (p. ej. alargar a voluntad la
// caducidad de una sesión de pago).
//
// Ahora: un secreto de PLATAFORMA dedicado solo a esto (HPP_SIGNING_SECRET). Es
// un secreto interno — el merchant nunca lo necesita: la URL la firma /hpp y la
// verifica /iframe, los dos en este mismo servidor.
//
// Si HPP_SIGNING_SECRET no está definido se genera uno aleatorio al arrancar.
// Funciona con UNA instancia (Render hoy); con varias instancias o tras un
// reinicio, una URL firmada por la instancia anterior deja de validar (el
// cliente solo tiene que volver a abrir el enlace /hpp). Por eso se avisa en el
// arranque y conviene definirlo en Render.

const crypto = require('crypto');

let SECRET = process.env.HPP_SIGNING_SECRET || '';
if (!SECRET) {
  SECRET = crypto.randomBytes(32).toString('hex');
  if (process.env.NODE_ENV !== 'test') {
    // eslint-disable-next-line no-console
    console.warn('⚠️ [WARN] HPP_SIGNING_SECRET no definido: se usa un secreto aleatorio por proceso. ' +
      'Defínelo en Render si hay más de una instancia.');
  }
}

function sign(payload) {
  return crypto
    .createHmac('sha256', SECRET)
    .update(JSON.stringify(payload))
    .digest('hex');
}

function verify(payload, signature) {
  const expected = Buffer.from(sign(payload), 'utf8');
  const given    = Buffer.from(String(signature || ''), 'utf8');
  if (expected.length !== given.length) return false;
  return crypto.timingSafeEqual(expected, given);
}

module.exports = { sign, verify };
