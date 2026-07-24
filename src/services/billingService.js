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
const Transaction   = require('../models/Transaction');
const PricingPlan   = require('../models/PricingPlan');
const BillingRecord = require('../models/BillingRecord');
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

// ── Fase 2 — cierre/finalización ────────────────────────────────────────────
function invoiceNumber(merchantId, period) {
  return `INV-${period}-${merchantId}`;
}

// ¿el período está CERRADO? (estrictamente anterior al mes de `now`). No se
// finaliza un mes en curso: cerraría una factura incompleta.
function isPeriodClosed(period, now) {
  const range = periodRange(period);
  if (!range) return false;
  const currentMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return range.end <= currentMonthStart;
}

async function getFinalized(merchantId, period) {
  return BillingRecord.findOne({ merchantId, period });
}

// Finaliza (congela) la factura de un período cerrado. IDEMPOTENTE: si ya existe,
// devuelve la existente sin recalcular. `now` lo pasa el caller (test determinista).
async function finalizeBilling(merchant, period, actor, now) {
  if (!periodRange(period)) { const e = new Error('invalid_period'); e.code = 'invalid_period'; throw e; }
  if (!isPeriodClosed(period, now || new Date())) {
    const e = new Error('period_not_closed'); e.code = 'period_not_closed'; throw e;
  }
  const existing = await BillingRecord.findOne({ merchantId: merchant.merchantId, period });
  if (existing) return existing;

  const pricing = await getPricing((merchant && merchant.plan) || 'free');
  const b = await computeBilling(merchant.merchantId, period, pricing);
  return BillingRecord.create({
    merchantId:    merchant.merchantId,
    period,
    invoiceNumber: invoiceNumber(merchant.merchantId, period),
    plan:          b.plan,
    currency:      b.currency,
    pricingSnapshot: {
      monthlyBase:       pricing.monthlyBase || 0,
      perTransactionFee: pricing.perTransactionFee || 0,
      volumeBps:         pricing.volumeBps || 0,
    },
    transactionsCount: b.transactionsCount,
    billableCount:     b.billableCount,
    billableVolume:    b.billableVolume,
    subscriptionFee:   b.subscriptionFee,
    usageFee:          b.usageFee,
    volumeFee:         b.volumeFee,
    totalDue:          b.totalDue,
    status:            'finalized',
    finalizedBy:       actor || null,
  });
}

async function listInvoices(merchantId, limit = 24) {
  return BillingRecord.find({ merchantId }).sort({ period: -1 }).limit(limit).lean();
}

module.exports = {
  BILLABLE_STATUSES, periodRange, periodOf, getPricing, computeBilling, billForMerchant,
  invoiceNumber, isPeriodClosed, getFinalized, finalizeBilling, listInvoices,
};
