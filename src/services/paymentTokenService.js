// src/services/paymentTokenService.js
'use strict';
//
// TARJETA GUARDADA / RECURRENTES (F6 framework multi-PSP, nov 2026).
// APAGADO detrás de FEATURE_SAVED_CARDS.
//
// Ciclo:
//   1. La sesión de checkout se crea con `saveCard: { customerRef }` (API v1).
//   2. El checkout enseña la casilla "Guardar esta tarjeta para próximos pagos".
//      Sin marcarla, no se guarda nada.
//   3. Al cobrar (/proxy-pci/charge) con la casilla marcada se crea el token
//      Monetiser en estado `pending` con el token del PSP CIFRADO y el
//      consentimiento (fecha, IP, navegador, versión del texto).
//   4. Cuando el PSP confirma el pago (webhook → authorized) el token pasa a
//      `active`. Si el pago no se aprueba, se descarta.
//   5. Pagos posteriores: POST /v1/payments con `paymentToken: pm_...`.
//      - initiator 'customer' (el cliente está delante: CIT) → mismo cobro
//        tokenizado con 3DS que el checkout.
//      - initiator 'merchant' (MIT: suscripciones, sin el cliente) → solo si el
//        conector declara capabilities.merchantInitiated. Paylands NO lo
//        declara: los indicadores que exige no están verificados.
//
// Nunca se expone el token del PSP: la API devuelve pm_... y el resumen de la
// tarjeta.

const crypto = require('crypto');
const PaymentToken = require('../models/PaymentToken');
const { encryptSecret, decryptSecret } = require('../utils/cryptoUtils');
const flags = require('../utils/featureFlags');

const CONSENT_TEXT_VERSION = 'v1-2026-11';
const CONSENT_TEXT = 'Guardar esta tarjeta para próximos pagos en este comercio';

function enabled() { return flags.savedCards(); }

function publicToken(doc) {
  if (!doc) return null;
  return {
    id: doc.tokenId,
    object: 'payment_token',
    livemode: Boolean(doc.livemode),
    customerRef: doc.customerRef,
    status: doc.status,
    card: { brand: doc.card?.brand || null, last4: doc.card?.last4 || null, expMonth: doc.card?.expMonth || null, expYear: doc.card?.expYear || null, country: doc.card?.country || null },
    connector: doc.connector,
    firstPaymentId: doc.firstPaymentId,
    consentAt: doc.consent?.at ? new Date(doc.consent.at).toISOString() : null,
    createdAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : null,
  };
}

async function createPending({ tx, pspToken, card = {}, consent = {} }) {
  if (!enabled()) return null;
  if (!tx || !tx.saveCardOffer || !tx.saveCardOffer.customerRef || !pspToken) return null;
  const doc = await PaymentToken.create({
    tokenId: 'pm_' + crypto.randomBytes(16).toString('hex'),
    merchantId: tx.merchantId,
    livemode: Boolean(tx.livemode),
    customerRef: tx.saveCardOffer.customerRef,
    connector: tx.processor || (tx.routing && tx.routing.connector) || 'payNoPain',
    connectorAccountId: tx.connectorAccountId || null,
    pspTokenEnc: encryptSecret(String(pspToken)),
    card,
    consent: { at: new Date(), ip: consent.ip || null, userAgent: String(consent.userAgent || '').slice(0, 256) || null, textVersion: CONSENT_TEXT_VERSION },
    firstPaymentId: tx.paymentId,
    status: 'pending',
  });
  return publicToken(doc);
}

async function activateForPayment(paymentId) {
  if (!enabled()) return;
  await PaymentToken.updateOne({ firstPaymentId: paymentId, status: 'pending' }, { $set: { status: 'active', updatedAt: new Date() } });
}

async function discardForPayment(paymentId) {
  if (!enabled()) return;
  await PaymentToken.updateOne({ firstPaymentId: paymentId, status: 'pending' }, { $set: { status: 'revoked', revokedAt: new Date(), updatedAt: new Date() } });
}

async function list(merchantId, livemode, customerRef) {
  const q = { merchantId, livemode: Boolean(livemode), status: 'active' };
  if (customerRef) q.customerRef = customerRef;
  const docs = await PaymentToken.find(q).sort({ createdAt: -1 }).limit(100).lean();
  return docs.map(publicToken);
}

async function get(merchantId, livemode, tokenId) {
  if (typeof tokenId !== 'string' || !/^pm_[0-9a-f]{32}$/.test(tokenId)) return null;
  const doc = await PaymentToken.findOne({ tokenId, merchantId }).lean();
  if (!doc || Boolean(doc.livemode) !== Boolean(livemode)) return null;
  return doc;
}

async function revoke(merchantId, livemode, tokenId) {
  const doc = await get(merchantId, livemode, tokenId);
  if (!doc) return null;
  await PaymentToken.updateOne({ tokenId, merchantId }, { $set: { status: 'revoked', revokedAt: new Date(), updatedAt: new Date() } });
  return publicToken({ ...doc, status: 'revoked' });
}

// Para cobrar: token ACTIVO de este merchant y modo → token del PSP descifrado.
async function resolveForCharge(merchantId, livemode, tokenId) {
  const doc = await get(merchantId, livemode, tokenId);
  if (!doc || doc.status !== 'active') return null;
  return { doc, pspToken: decryptSecret(doc.pspTokenEnc) };
}

module.exports = {
  enabled, createPending, activateForPayment, discardForPayment, list, get, revoke, resolveForCharge, publicToken,
  CONSENT_TEXT, CONSENT_TEXT_VERSION,
};
