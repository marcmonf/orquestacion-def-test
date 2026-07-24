// src/services/billingService.js
'use strict';
//
// Servicio de facturación (M7 Fase 1) — MEDICIÓN y CÁLCULO, sin cobro real.
//
// Calcula, para un merchant y un período (mes 'YYYY-MM'), lo que debe según su
// plan y la config de precios. Factura sobre transacciones FACTURABLES (las que
// representan procesamiento con éxito); las declinadas/canceladas/reembolsadas no
// se cobran en v1. Importes en CÉNTIMOS.
//
const Transaction = require('../models/Transaction');
const PricingPlan = require('../models/PricingPlan');
const { defaultsFor } = require('../utils/pricingDefaults');

// Estados que se facturan (procesamiento con éxito).
const BILLABLE_STATUSES = ['approved', 'authorized', 'captured', 'partially_captured'];

// 'YYYY-MM' → { start, end } (rango [inicio, fin) del mes, en UTC). null si inválido.
function periodRange(period) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(period || ''));
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  return { start: new Date(Date.UTC(y, mo - 1, 1)), end: new Date(Date.UTC(y, mo, 1)) };
}

// Date → 'YYYY-MM' (el caller pasa la fecha; así el core es determinista en tests).
function periodOf(date) {
  const y = date.getUTCFullYear();
  const mo = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${mo}`;
}

// Precio efectivo de un plan: fila de PricingPlan si existe, si no los placeholders.
async function getPricing(plan) {
  const doc = await PricingPlan.findOne({ plan });
  if (!doc) return defaultsFor(plan);
  return {
    plan,
    currency:          doc.currency || 'EUR',
    monthlyBase:       doc.monthlyBase || 0,
    perTransactionFee: doc.perTransactionFee || 0,
    volumeBps:         doc.volumeBps || 0,
  };
}

// Cálculo puro (consulta Transaction). pricing = objeto con las 3 dimensiones.
async function computeBilling(merchantId, period, pricing) {
  const range = periodRange(period);
  if (!range) throw new Error('invalid_period');

  const base = { merchantId, createdAt: { $gte: range.start, $lt: range.end } };
  const [transactionsCount, billableCount, volAgg] = await Promise.all([
    Transaction.countDocuments(base),
    Transaction.countDocuments({ ...base, status: { $in: BILLABLE_STATUSES } }),
    Transaction.aggregate([
      { $match: { ...base, status: { $in: BILLABLE_STATUSES } } },
      { $group: { _id: null, vol: { $sum: '$amount' } } },
    ]),
  ]);
  const billableVolume  = (volAgg[0] && volAgg[0].vol) || 0;
  const subscriptionFee = pricing.monthlyBase || 0;
  const usageFee        = (pricing.perTransactionFee || 0) * billableCount;
  const volumeFee       = Math.round(billableVolume * (pricing.volumeBps || 0) / 10000);
  const totalDue        = subscriptionFee + usageFee + volumeFee;

  return {
    merchantId, period,
    plan:     pricing.plan,
    currency: pricing.currency || 'EUR',
    transactionsCount,
    billableCount,
    billableVolume,          // céntimos
    subscriptionFee,         // céntimos
    usageFee,                // céntimos
    volumeFee,               // céntimos
    totalDue,                // céntimos
  };
}

// Resuelve el precio del plan del merchant y calcula.
async function billForMerchant(merchant, period) {
  const pricing = await getPricing((merchant && merchant.plan) || 'free');
  return computeBilling(merchant.merchantId, period, pricing);
}

module.exports = {
  BILLABLE_STATUSES, periodRange, periodOf, getPricing, computeBilling, billForMerchant,
};
