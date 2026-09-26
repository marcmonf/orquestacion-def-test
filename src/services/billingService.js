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
    // Los datos fiscales del cliente se guardan en su ficha de contrato aunque
    // la tarifa propia esté desactivada (se factura por plan): antes, sin
    // contrato activo, la factura salía SIN datos del receptor.
    recipient: (contract && contract.billing) || {},
  };
}

// Cálculo de las CUOTAS (base imponible, sin impuesto). `config` = objeto de
// resolveConfig o una tarifa por plan antigua ({ monthlyBase, ... }).
async function computeBilling(merchantId, period, config, activeUsers = 0) {
  const range = periodRange(period);
  if (!range) { const e = new Error('invalid_period'); e.code = 'invalid_period'; throw e; }

  const base = { merchantId, createdAt: { $gte: range.start, $lt: range.end } };
  // Salvaguardas de lo FACTURABLE (26 sep 2026):
  //   - importe > 0: antes un importe negativo creado por API restaba de la
  //     factura (se podía dejar la factura en negativo);
  //   - nunca el conector simulado (dummyCard aprueba sin mover dinero);
  //   - solo la divisa de la tarifa: antes se sumaban EUR, JPY y KWD como si
  //     fueran la misma moneda.
  const billableFilter = {
    ...base,
    status:    { $in: BILLABLE_STATUSES },
    amount:    { $gt: 0 },
    processor: { $ne: 'dummyCard' },
    currency:  config.currency || 'EUR',
  };
  const [transactionsCount, billableCount, volAgg] = await Promise.all([
    Transaction.countDocuments(base),
    Transaction.countDocuments(billableFilter),
    Transaction.aggregate([
      { $match: billableFilter },
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

// ── Datos fiscales obligatorios ──────────────────────────────────────────────
// Una factura sin razón social, NIF o domicilio de emisor y destinatario no es
// una factura válida (Reglamento de facturación, RD 1619/2012, art. 6). Antes se
// emitía igual, con los campos en blanco, y además consumía número: una factura
// emitida no se puede borrar (habría que rectificarla).
const REQUIRED_FISCAL_FIELDS = [
  ['issuer.legalName',          'Razón social del emisor (/admin → Facturación → Datos de la Sociedad)'],
  ['issuer.taxId',              'NIF/CIF del emisor'],
  ['issuer.address.street',     'Dirección del emisor'],
  ['issuer.address.postalCode', 'Código postal del emisor'],
  ['issuer.address.city',       'Ciudad del emisor'],
  ['recipient.legalName',       'Razón social del cliente (/admin → Merchants → Tarifa)'],
  ['recipient.taxId',           'NIF/CIF del cliente'],
  ['recipient.street',          'Dirección del cliente'],
  ['recipient.postalCode',      'Código postal del cliente'],
  ['recipient.city',            'Ciudad del cliente'],
];

function pick(obj, path) {
  return path.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
}

function missingFiscalData(issuer, recipient) {
  const doc = { issuer, recipient };
  return REQUIRED_FISCAL_FIELDS
    .filter(([path]) => !String(pick(doc, path) || '').trim())
    .map(([path, label]) => ({ field: path, label }));
}

function buildRecipient(merchant, config) {
  const r = config.recipient || {};
  return {
    merchantId: merchant.merchantId,
    legalName:  r.legalName || '',
    taxId:      r.taxId || '',
    street:     r.street || '',
    city:       r.city || '',
    postalCode: r.postalCode || '',
    province:   r.province || '',
    country:    r.country || 'ES',
    email:      r.email || '',
  };
}

function buildIssuer(company) {
  return {
    legalName: company.legalName, tradeName: company.tradeName, taxId: company.taxId,
    address: company.address, email: company.email, phone: company.phone, iban: company.iban,
    taxRegime: company.taxRegime, logoDataUrl: company.logoDataUrl, footerNotes: company.footerNotes,
  };
}

// ── Numeración correlativa SIN HUECOS ────────────────────────────────────────
// Formato 'A-2026-0001' (serie-año-secuencia; a partir de 9999 crece a 5 cifras).
//
// Antes: un contador ($inc en invoicecounters) se incrementaba ANTES de crear la
// factura. Si la creación fallaba —o dos peticiones finalizaban a la vez el
// mismo merchant y período y una perdía contra el índice único— el número ya
// estaba gastado: hueco en la numeración, que la normativa exige correlativa.
//
// Ahora el número se "gasta" SOLO al crearse la factura: siguiente = última
// emitida de esa serie y año + 1, y el índice único de invoiceNumber impide que
// dos facturas cojan el mismo; si chocan, la perdedora reintenta con el
// siguiente. Si lo que choca es el merchant+período (otra petición la emitió a
// la vez), se devuelve esa factura. Sin transacciones: vale en Atlas y en local.
const MAX_NUMBER_ATTEMPTS = 8;

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatInvoiceNumber(series, year, seq) {
  return `${series}-${year}-${String(seq).padStart(4, '0')}`;
}

async function lastInvoiceSeq(series, year) {
  const prefix = `${series}-${year}-`;
  const rows = await BillingRecord
    .find({ invoiceNumber: { $regex: `^${escapeRegex(prefix)}\\d+$` } })
    .select('invoiceNumber')
    .lean();
  return rows.reduce((max, r) => {
    const n = parseInt(String(r.invoiceNumber).slice(prefix.length), 10);
    return Number.isFinite(n) && n > max ? n : max;
  }, 0);
}

function isDuplicateKey(err) {
  return Boolean(err) && (err.code === 11000 || /E11000/.test(String(err.message || '')));
}

async function createWithNextNumber(series, year, data) {
  for (let attempt = 0; attempt < MAX_NUMBER_ATTEMPTS; attempt += 1) {
    const invoiceNumber = formatInvoiceNumber(series, year, (await lastInvoiceSeq(series, year)) + 1);
    try {
      return await BillingRecord.create({ ...data, invoiceNumber });
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      const existing = await BillingRecord.findOne({ merchantId: data.merchantId, period: data.period });
      if (existing) return existing;   // otra petición emitió esta misma factura a la vez
      // Si no, otra factura se llevó ese número a la vez: se prueba el siguiente.
    }
  }
  const e = new Error('invoice_number_contention');
  e.code = 'invoice_number_contention';
  throw e;
}

// Finaliza (emite) la factura de un período CERRADO. Idempotente. Congela cifras,
// impuesto, número correlativo y snapshots de emisor/receptor. Exige los datos
// fiscales completos ANTES de asignar número (error 'fiscal_data_incomplete' con
// la lista `missing`).
async function finalizeBilling(merchant, period, actor, now) {
  if (!periodRange(period)) { const e = new Error('invalid_period'); e.code = 'invalid_period'; throw e; }
  if (!isPeriodClosed(period, now || new Date())) { const e = new Error('period_not_closed'); e.code = 'period_not_closed'; throw e; }
  const existing = await BillingRecord.findOne({ merchantId: merchant.merchantId, period });
  if (existing) return existing;

  const config = await resolveConfig(merchant);
  const company = await getCompany();
  const recipient = buildRecipient(merchant, config);
  const issuer = buildIssuer(company);
  const missing = missingFiscalData(issuer, recipient);
  if (missing.length) {
    const e = new Error('fiscal_data_incomplete');
    e.code = 'fiscal_data_incomplete';
    e.missing = missing;
    throw e;
  }

  const b = await billForMerchant(merchant, period);
  const year = period.split('-')[0];
  return createWithNextNumber(company.invoiceSeries || 'A', year, {
    merchantId: merchant.merchantId, period,
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

// Finaliza el período para una lista de merchants SIN pararse en el primero que
// falle (antes, un merchant sin datos fiscales cortaba el lote con un 500 y los
// demás quedaban a medias). Devuelve el resumen y los que no se pudieron emitir.
async function finalizeMany(merchants, period, actor, now) {
  const out = { finalized: [], already: [], skipped: [] };
  for (const m of merchants) {
    try {
      const existed = await getFinalized(m.merchantId, period);
      if (existed) { out.already.push(existed); continue; }
      out.finalized.push(await finalizeBilling(m, period, actor, now));
    } catch (err) {
      if (!err.code) console.error(`❌ [billing] finalizando ${m.merchantId} ${period}:`, err);
      out.skipped.push({
        merchantId: m.merchantId,
        error: err.code || 'internal_error',
        ...(err.missing ? { missing: err.missing } : {}),
      });
    }
  }
  return out;
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
  billForMerchant, isPeriodClosed, getFinalized, finalizeBilling, finalizeMany,
  missingFiscalData, formatInvoiceNumber, listInvoices, getInvoice, markSent,
};
