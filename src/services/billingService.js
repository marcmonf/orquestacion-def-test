// src/services/billingService.js
'use strict';
//
// Servicio de facturación (M7). Calcula, para un merchant y un período (mes
// 'YYYY-MM'), lo que debe por LO NUESTRO (pasarela + servicios) según su CONTRATO
// (o su plan como fallback), aplica el impuesto (IGIC — Sociedad en Canarias) y, al
// FINALIZAR un período cerrado, emite una FACTURA OFICIAL con numeración correlativa
// y snapshots inmutables de emisor y receptor.
//
// SOLO factura lo nuestro. La adquirencia es informativa (Bloque 2), nunca se
// factura (capa tecnológica, no payfac). Importes en CÉNTIMOS.
//
const Transaction    = require('../models/Transaction');
const PricingPlan    = require('../models/PricingPlan');
const BillingRecord  = require('../models/BillingRecord');
const MerchantContract = require('../models/MerchantContract');
const MerchantUser   = require('../models/MerchantUser');
const InvoiceCounter = require('../models/InvoiceCounter');
const { defaultsFor } = require('../utils/pricingDefaults');
const { getTaxRate } = require('./taxService');
const { getCompany } = require('./companyService');

const BILLABLE_STATUSES = ['approved', 'authorized', 'captured', 'partially_captured'];

// 'YYYY-MM' → { start, end } (rango [inicio, fin) del mes, UTC). null si inválido.
function periodRange(period) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(period || ''));
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  return { start: new Date(Date.UTC(y, mo - 1, 1)), end: new Date(Date.UTC(y, mo, 1)) };
}
function periodOf(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Precio por plan (fallback si el merchant no tiene contrato).
async function getPricing(plan) {
  const doc = await PricingPlan.findOne({ plan });
  if (!doc) return defaultsFor(plan);
  return { plan, currency: doc.currency || 'EUR', monthlyBase: doc.monthlyBase || 0, perTransactionFee: doc.perTransactionFee || 0, volumeBps: doc.volumeBps || 0 };
}

// Config de facturación efectiva del merchant: su CONTRATO si existe, si no su plan.
async function resolveConfig(merchant) {
  const contract = await MerchantContract.findOne({ merchantId: merchant.merchantId }).lean();
  if (contract && contract.active !== false) {
    return {
      source: 'contract',
      currency: contract.currency || 'EUR',
      monthlyMaintenance: contract.monthlyMaintenance || 0,
      perTransactionFee: contract.perTransactionFee || 0,
      volumeBps: contract.volumeBps || 0,
      perUserFee: contract.perUserFee || 0,
      includedUsers: contract.includedUsers || 0,
      services: (contract.services || []).filter(s => s.active !== false),
      taxRateCode: contract.taxRateCode || 'IGIC_GENERAL',
      recipient: contract.billing || {},
    };
  }
  const pricing = await getPricing((merchant && merchant.plan) || 'free');
  return {
    source: 'plan',
    currency: pricing.currency || 'EUR',
    monthlyMaintenance: pricing.monthlyBase || 0,
    perTransactionFee: pricing.perTransactionFee || 0,
    volumeBps: pricing.volumeBps || 0,
    perUserFee: 0, includedUsers: 0, services: [],
    taxRateCode: 'IGIC_GENERAL',
    recipient: {},
  };
}

// Cálculo de las CUOTAS (base imponible, sin impuesto). `config` = objeto de
// resolveConfig o una tarifa por plan antigua ({ monthlyBase, ... }).
async function computeBilling(merchantId, period, config, activeUsers = 0) {
  const range = periodRange(period);
  if (!range) { const e = new Error('invalid_period'); e.code = 'invalid_period'; throw e; }

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
  const subscriptionFee = config.monthlyMaintenance != null ? config.monthlyMaintenance : (config.monthlyBase || 0);
  const usageFee        = (config.perTransactionFee || 0) * billableCount;
  const volumeFee       = Math.round(billableVolume * (config.volumeBps || 0) / 10000);
  const extraUsers      = Math.max(0, activeUsers - (config.includedUsers || 0));
  const userFee         = (config.perUserFee || 0) * extraUsers;
  const services        = config.services || [];
  const servicesFee     = services.reduce((s, x) => s + (x.monthlyPrice || 0), 0);
  const subtotal        = subscriptionFee + usageFee + volumeFee + userFee + servicesFee;

  const lines = [];
  if (subscriptionFee) lines.push({ label: 'Mantenimiento mensual', amount: subscriptionFee });
  if (usageFee)        lines.push({ label: `Transacciones (${billableCount})`, amount: usageFee });
  if (volumeFee)       lines.push({ label: 'Comisión por volumen', amount: volumeFee });
  if (userFee)         lines.push({ label: `Usuarios adicionales (${extraUsers})`, amount: userFee });
  services.forEach(x => { if (x.monthlyPrice) lines.push({ label: x.label || x.code, amount: x.monthlyPrice }); });

  return {
    merchantId, period, plan: config.plan, currency: config.currency || 'EUR',
    transactionsCount, billableCount, billableVolume,
    subscriptionFee, usageFee, volumeFee, userFee, servicesFee,
    subtotal, totalDue: subtotal, lines,
  };
}

// Factura (borrador) completa: cuotas + impuesto (IGIC) del merchant.
async function billForMerchant(merchant, period) {
  const config = await resolveConfig(merchant);
  const activeUsers = config.perUserFee > 0
    ? await MerchantUser.countDocuments({ merchantId: merchant.merchantId, active: true })
    : 0;
  const fees = await computeBilling(merchant.merchantId, period, { ...config, plan: merchant.plan }, activeUsers);
  const tax = await getTaxRate(config.taxRateCode);
  const taxAmount = Math.round(fees.subtotal * (tax.percent || 0) / 100);
  return {
    ...fees,
    taxCode: tax.code, taxLabel: tax.label, taxPercent: tax.percent || 0, taxNote: tax.legalNote || '',
    taxAmount, total: fees.subtotal + taxAmount,
  };
}

// ── Cierre / factura oficial ─────────────────────────────────────────────────
function isPeriodClosed(period, now) {
  const range = periodRange(period);
  if (!range) return false;
  const currentMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return range.end <= currentMonthStart;
}

async function getFinalized(merchantId, period) {
  return BillingRecord.findOne({ merchantId, period });
}

// Número correlativo atómico por serie+año. Formato: 'A-2026-0001'.
async function nextInvoiceNumber(series, year) {
  const key = `${series}-${year}`;
  const c = await InvoiceCounter.findOneAndUpdate({ key }, { $inc: { last: 1 } }, { new: true, upsert: true });
  const n = (c && c.last) || 1;
  return `${series}-${year}-${String(n).padStart(4, '0')}`;
}

// Finaliza (emite) la factura de un período CERRADO. Idempotente. Congela cifras,
// impuesto, número correlativo y snapshots de emisor/receptor.
async function finalizeBilling(merchant, period, actor, now) {
  if (!periodRange(period)) { const e = new Error('invalid_period'); e.code = 'invalid_period'; throw e; }
  if (!isPeriodClosed(period, now || new Date())) { const e = new Error('period_not_closed'); e.code = 'period_not_closed'; throw e; }
  const existing = await BillingRecord.findOne({ merchantId: merchant.merchantId, period });
  if (existing) return existing;

  const config = await resolveConfig(merchant);
  const b = await billForMerchant(merchant, period);
  const company = await getCompany();
  const year = period.split('-')[0];
  const invoiceNumber = await nextInvoiceNumber(company.invoiceSeries || 'A', year);

  const recipient = {
    merchantId: merchant.merchantId,
    legalName: (config.recipient && config.recipient.legalName) || merchant.name || merchant.merchantId,
    taxId:      (config.recipient && config.recipient.taxId) || '',
    street:     (config.recipient && config.recipient.street) || '',
    city:       (config.recipient && config.recipient.city) || '',
    postalCode: (config.recipient && config.recipient.postalCode) || '',
    province:   (config.recipient && config.recipient.province) || '',
    country:    (config.recipient && config.recipient.country) || 'ES',
    email:      (config.recipient && config.recipient.email) || '',
  };
  const issuer = {
    legalName: company.legalName, tradeName: company.tradeName, taxId: company.taxId,
    address: company.address, email: company.email, phone: company.phone, iban: company.iban,
    taxRegime: company.taxRegime, logoDataUrl: company.logoDataUrl, footerNotes: company.footerNotes,
  };

  return BillingRecord.create({
    merchantId: merchant.merchantId, period, invoiceNumber,
    plan: b.plan, currency: b.currency,
    pricingSnapshot: { monthlyBase: b.subscriptionFee, perTransactionFee: config.perTransactionFee || 0, volumeBps: config.volumeBps || 0 },
    transactionsCount: b.transactionsCount, billableCount: b.billableCount, billableVolume: b.billableVolume,
    subscriptionFee: b.subscriptionFee, usageFee: b.usageFee, volumeFee: b.volumeFee,
    userFee: b.userFee, servicesFee: b.servicesFee, totalDue: b.subtotal,
    lines: b.lines, subtotal: b.subtotal,
    taxCode: b.taxCode, taxLabel: b.taxLabel, taxPercent: b.taxPercent, taxNote: b.taxNote,
    taxAmount: b.taxAmount, total: b.total,
    issuer, recipient,
    status: 'finalized', finalizedBy: actor || null,
  });
}

async function listInvoices(merchantId, limit = 24) {
  return BillingRecord.find({ merchantId }).sort({ period: -1 }).limit(limit).lean();
}

// Factura por id. Si se pasa merchantId, la acota a ese merchant (portal).
async function getInvoice(invoiceId, merchantId) {
  return BillingRecord.findOne(merchantId ? { _id: invoiceId, merchantId } : { _id: invoiceId });
}

async function markSent(invoiceId, to) {
  return BillingRecord.findOneAndUpdate({ _id: invoiceId }, { $set: { sentAt: new Date(), sentTo: to || null } }, { new: true });
}

module.exports = {
  BILLABLE_STATUSES, periodRange, periodOf, getPricing, resolveConfig, computeBilling,
  billForMerchant, isPeriodClosed, getFinalized, nextInvoiceNumber, finalizeBilling,
  listInvoices, getInvoice, markSent,
};
