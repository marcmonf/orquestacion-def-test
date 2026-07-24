// src/utils/pricingDefaults.js
'use strict';
//
// Precios por plan (M7 Fase 1 — Billing). Modelo FLEXIBLE: tres dimensiones que
// se combinan (deja en 0 las que no uses):
//   - monthlyBase       → cuota mensual fija del plan (céntimos)
//   - perTransactionFee → fee por transacción facturable (céntimos)
//   - volumeBps         → puntos básicos sobre el volumen facturado (50 = 0,5%);
//                         fee = volumen * bps / 10000
// TODO en CÉNTIMOS.
//
// Estos valores son PLACEHOLDERS editables: Marcos los ajusta sin desplegar vía
// `PUT /backoffice/pricing/:plan`. En Fase 1 NO se cobra dinero real (eso es la
// Fase 3, con Stripe/Paddle): estos importes solo alimentan la factura-borrador
// informativa que ve cada merchant.
//
const PLANS = ['free', 'starter', 'growth', 'enterprise'];

const DEFAULT_PRICING = {
  free:       { monthlyBase: 0,    perTransactionFee: 0,  volumeBps: 0 },
  starter:    { monthlyBase: 2900, perTransactionFee: 15, volumeBps: 0 },
  growth:     { monthlyBase: 9900, perTransactionFee: 10, volumeBps: 0 },
  enterprise: { monthlyBase: 0,    perTransactionFee: 0,  volumeBps: 0 }, // negociado / custom
};

function defaultsFor(plan) {
  const base = DEFAULT_PRICING[plan] || DEFAULT_PRICING.free;
  return { plan: PLANS.includes(plan) ? plan : 'free', currency: 'EUR', ...base };
}

module.exports = { PLANS, DEFAULT_PRICING, defaultsFor };
