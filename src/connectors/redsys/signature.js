// src/connectors/redsys/signature.js
'use strict';
//
// FIRMA HMAC_SHA256_V1 DE REDSYS (sesión 6 nov 2026, F1 Redsys).
//
// Fuente: "Manual integración para conexión por Redirección" de Redsys
// (canales.redsys.es), verificado por Marcos. canales.redsys.es y
// pagosonline.redsys.es estaban BLOQUEADOS desde el contenedor donde se
// escribió esto: el algoritmo es el que Marcos copió del manual:
//
//   1. clave del comercio (texto Base64) → decodificar Base64
//   2. clave de la operación = cifrado 3DES de Ds_Merchant_Order con esa clave
//   3. Ds_Signature = Base64( HMAC-SHA256( Ds_MerchantParameters (ya en Base64),
//                                          clave de la operación ) )
//
// Detalles del paso 2 que el resumen del manual NO dice y que aquí se fijan de
// la forma habitual de 3DES con un dato de longitud variable: modo CBC, vector
// inicial de ceros y relleno con ceros hasta múltiplo de 8 bytes. PENDIENTES DE
// VERIFICAR contra Redsys real (DEV-LOG, sesión 6 nov): si la primera prueba
// del runbook (docs/redsys.md) da error de firma (SIS0042), es aquí.
//
// La firma de la notificación se compara aceptando Base64 estándar y su
// variante para URL ('-' y '_' en lugar de '+' y '/'): la comparación no se
// relaja, solo se normaliza el alfabeto.

const crypto = require('crypto');

const SIGNATURE_VERSION = 'HMAC_SHA256_V1';

function decodeKey(keyB64) {
  const key = Buffer.from(String(keyB64 || ''), 'base64');
  // 3DES (des-ede3) usa una clave de 24 bytes.
  if (key.length !== 24) throw Object.assign(new Error('Clave de Redsys no válida (Base64 de 24 bytes)'), { code: 'invalid_key' });
  return key;
}

function zeroPad(buf) {
  const rem = buf.length % 8;
  return rem === 0 ? buf : Buffer.concat([buf, Buffer.alloc(8 - rem)]);
}

// Paso 2: clave de la operación.
function operationKey(keyB64, order) {
  const cipher = crypto.createCipheriv('des-ede3-cbc', decodeKey(keyB64), Buffer.alloc(8));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(zeroPad(Buffer.from(String(order), 'utf8'))), cipher.final()]);
}

// Ds_MerchantParameters: JSON en Base64.
function encodeParams(params) {
  return Buffer.from(JSON.stringify(params), 'utf8').toString('base64');
}

// Normaliza Base64 (estándar o variante URL; los '+' convertidos en espacio
// por un formulario urlencoded se recuperan: el espacio no existe en Base64).
function normB64(s) {
  return String(s || '').trim().replace(/ /g, '+').replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
}

function decodeParams(paramsB64) {
  try {
    const json = Buffer.from(normB64(paramsB64), 'base64').toString('utf8');
    const o = JSON.parse(json);
    return o && typeof o === 'object' ? o : null;
  } catch (_) {
    return null;
  }
}

// Paso 3.
function sign(keyB64, order, paramsB64) {
  return crypto.createHmac('sha256', operationKey(keyB64, order)).update(String(paramsB64)).digest('base64');
}

/** Campos a enviar a Redsys para unos parámetros. */
function buildRequest(keyB64, params) {
  const order = params.Ds_Merchant_Order;
  const Ds_MerchantParameters = encodeParams(params);
  return {
    Ds_SignatureVersion: SIGNATURE_VERSION,
    Ds_MerchantParameters,
    Ds_Signature: sign(keyB64, order, Ds_MerchantParameters),
  };
}

/**
 * Verifica una notificación / respuesta firmada de Redsys.
 * El pedido para derivar la clave sale de los parámetros (Ds_Order; en su
 * defecto Ds_Merchant_Order).
 * → { ok:true, params } | { ok:false, reason }
 */
function verify(keyB64, { Ds_SignatureVersion, Ds_MerchantParameters, Ds_Signature } = {}) {
  if (Ds_SignatureVersion && Ds_SignatureVersion !== SIGNATURE_VERSION) return { ok: false, reason: 'signature_version' };
  if (!Ds_MerchantParameters || !Ds_Signature) return { ok: false, reason: 'missing_fields' };
  const params = decodeParams(Ds_MerchantParameters);
  if (!params) return { ok: false, reason: 'bad_parameters' };
  const order = params.Ds_Order || params.Ds_Merchant_Order;
  if (!order) return { ok: false, reason: 'missing_order' };
  let expected;
  // La firma se calcula sobre la cadena TAL COMO LLEGA (solo se recuperan los
  // '+' que un formulario urlencoded convierte en espacios).
  const received = String(Ds_MerchantParameters).trim().replace(/ /g, '+');
  try { expected = sign(keyB64, order, received); } catch (_) { return { ok: false, reason: 'invalid_key' }; }
  const a = Buffer.from(normB64(expected));
  const b = Buffer.from(normB64(Ds_Signature));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'bad_signature' };
  return { ok: true, params };
}

module.exports = { SIGNATURE_VERSION, operationKey, encodeParams, decodeParams, sign, buildRequest, verify, decodeKey };
