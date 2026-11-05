// src/services/insightsService.js
'use strict';
//
// INSIGHTS DE ORQUESTACIÓN (sesión 5 nov 2026, F2). SOLO LECTURA.
//
// Para un periodo (y un merchant, o todos en /admin):
//   - tasa de aprobación (global y por PSP)
//   - motivos de rechazo NORMALIZADOS (taxonomía de src/connectors/errors.js)
//   - tasa de 3DS
//   - coste real por transacción (Interchange++ con costService y las tarifas
//     existentes: interchange + scheme fees del adquirente + margen del
//     adquirente del merchant; sin la fee de Monetiser)
//   - comparativa por PSP y por qué se enrutó cada pago (routing.reason)
//
// Los recuentos se AGREGAN EN MONGO (un $match por createdAt [+ merchantId],
// cubierto por los índices { merchantId:1, createdAt:-1 } y { createdAt:-1 },
// y un $group). El coste se calcula sobre una MUESTRA acotada de pagos
// aprobados (COST_SAMPLE) porque depende de tablas de interchange.

const Transaction = require('../models/Transaction');
const MerchantAcquirer = require('../models/MerchantAcquirer');
const Merchant = require('../models/Merchant');
const costService = require('./costService');
const { DEFAULT_ACQUIRERS } = require('../utils/acquirerDefaults');
const { fromTransaction } = require('../utils/cardContext');
const { ERROR_CODES } = require('../connectors/errors');

const APPROVED = Object.freeze(['authorized', 'approved', 'partially_captured', 'captured', 'partially_refunded', 'refunded']);
const DECLINED = Object.freeze(['declined']);
const ERRORED = Object.freeze(['error']);
const COST_SAMPLE = 2000;
const MAX_DAYS = 366;

function range({ days = 30, now = new Date() } = {}) {
  const d = Math.min(Math.max(parseInt(days, 10) || 30, 1), MAX_DAYS);
  return { from: new Date(now.getTime() - d * 86400000), to: now, days: d };
}

// Pipeline de Mongo: una fila por combinación (psp, estado, motivo, routing, 3DS).
function pipeline(match) {
  return [
    { $match: match },
    { $group: {
      _id: {
        psp: { $ifNull: ['$processor', { $ifNull: ['$routing.connector', 'sin_psp'] }] },
        status: '$status',
        declineCode: { $ifNull: ['$declineCode', null] },
        routingReason: { $ifNull: ['$routing.reason', 'sin_routing'] },
        threeDS: { $eq: ['$threeDS', true] },
      },
      count: { $sum: 1 },
      amount: { $sum: { $ifNull: ['$amount', 0] } },
    } },
  ];
}

const rate = (a, b) => (b ? Number((a / b * 100).toFixed(1)) : null);

// Compone las métricas a partir de las filas agrupadas (lógica pura, testeable).
function summarize(rows) {
  const psps = {};
  const reasons = {};
  const routing = {};
  const tot = { payments: 0, approved: 0, declined: 0, errors: 0, finished: 0, threeDS: 0, approvedVolume: 0 };
  const pspOf = (id) => (psps[id] = psps[id] || { psp: id, payments: 0, approved: 0, declined: 0, errors: 0, threeDS: 0, approvedVolume: 0, routing: {} });
  for (const r of rows || []) {
    const k = r._id || {};
    const p = pspOf(k.psp || 'sin_psp');
    const n = Number(r.count) || 0;
    p.payments += n; tot.payments += n;
    if (k.threeDS) { p.threeDS += n; tot.threeDS += n; }
    if (APPROVED.includes(k.status)) { p.approved += n; tot.approved += n; p.approvedVolume += Number(r.amount) || 0; tot.approvedVolume += Number(r.amount) || 0; }
    if (DECLINED.includes(k.status) || ERRORED.includes(k.status)) {
      const code = k.declineCode && ERROR_CODES[k.declineCode] ? k.declineCode : (DECLINED.includes(k.status) ? 'motivo_no_informado' : 'error_sin_codigo');
      reasons[code] = (reasons[code] || 0) + n;
    }
    if (DECLINED.includes(k.status)) { p.declined += n; tot.declined += n; }
    if (ERRORED.includes(k.status)) { p.errors += n; tot.errors += n; }
    routing[k.routingReason || 'sin_routing'] = (routing[k.routingReason || 'sin_routing'] || 0) + n;
    p.routing[k.routingReason || 'sin_routing'] = (p.routing[k.routingReason || 'sin_routing'] || 0) + n;
  }
  tot.finished = tot.approved + tot.declined + tot.errors;
  const byPsp = Object.values(psps).map((p) => {
    const finished = p.approved + p.declined + p.errors;
    return { ...p, finished, approvalRatePct: rate(p.approved, finished), threeDSRatePct: rate(p.threeDS, p.payments) };
  }).sort((a, b) => b.payments - a.payments);
  const totalReasons = Object.values(reasons).reduce((a, b) => a + b, 0);
  return {
    totals: { ...tot, approvalRatePct: rate(tot.approved, tot.finished), threeDSRatePct: rate(tot.threeDS, tot.payments) },
    byPsp,
    declineReasons: Object.entries(reasons).map(([code, count]) => ({
      code, count, sharePct: rate(count, totalReasons),
      description: ERROR_CODES[code] ? ERROR_CODES[code].description : (code === 'motivo_no_informado' ? 'El PSP no informó el motivo.' : 'Error técnico sin código.'),
    })).sort((a, b) => b.count - a.count),
    routingReasons: Object.entries(routing).map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
  };
}

// Coste real (Interchange++) por PSP sobre una muestra de pagos aprobados.
async function costs(match) {
  const txs = await Transaction.find({ ...match, status: { $in: APPROVED } })
    .select({ merchantId: 1, processor: 1, amount: 1, cardBrand: 1, cardType: 1, cardLevel: 1, issuerCountry: 1, bin: 1 })
    .sort({ createdAt: -1 }).limit(COST_SAMPLE).lean();
  if (!txs.length) return { sampled: 0, byPsp: [] };
  const interchangeRows = await costService.getInterchangeTable();
  const merchantIds = [...new Set(txs.map((t) => t.merchantId))];
  const [mas, merchants] = await Promise.all([
    MerchantAcquirer.find({ merchantId: { $in: merchantIds } }).lean(),
    Merchant.find({ merchantId: { $in: merchantIds } }).select({ merchantId: 1, country: 1 }).lean(),
  ]);
  const countryOf = Object.fromEntries((merchants || []).map((m) => [m.merchantId, m.country]));
  const acqOf = (psp) => DEFAULT_ACQUIRERS.find((a) => a.connectorKey === psp) || null;
  const out = {};
  for (const tx of txs) {
    const psp = tx.processor || 'sin_psp';
    const acquirer = acqOf(psp);
    const codes = acquirer ? [acquirer.code, psp] : [psp];
    const ma = (mas || []).find((m) => m.merchantId === tx.merchantId && codes.includes(m.acquirerCode)) || null;
    const est = costService.estimateForContext(fromTransaction(tx, countryOf[tx.merchantId]), { acquirer, merchantAcquirer: ma, interchangeRows, gatewayPerTx: 0 });
    const o = (out[psp] = out[psp] || { psp, sampled: 0, volume: 0, cost: 0, interchange: 0, schemeFee: 0, acquirerMarkup: 0, withoutCardData: 0 });
    o.sampled += 1; o.volume += est.amount; o.cost += est.total;
    o.interchange += est.interchange; o.schemeFee += est.schemeFee; o.acquirerMarkup += est.acquirerMarkup;
    if (!tx.cardBrand) o.withoutCardData += 1;
  }
  return {
    sampled: txs.length,
    byPsp: Object.values(out).map((o) => ({
      ...o,
      avgCostPerTx: Math.round(o.cost / o.sampled),
      effectiveRatePct: o.volume ? Number((o.cost / o.volume * 100).toFixed(3)) : 0,
    })),
    disclaimer: costService.COST_DISCLAIMER,
  };
}

/**
 * @param {object} p
 * @param {string|string[]|null} p.merchantId  null = todos; lista = alcance del usuario de /admin
 * @param {number} [p.days]
 * @param {boolean} [p.livemode]     undefined = todos
 */
async function compute({ merchantId = null, days = 30, livemode } = {}) {
  const r = range({ days });
  const match = { createdAt: { $gte: r.from, $lt: r.to } };
  if (Array.isArray(merchantId)) match.merchantId = { $in: merchantId };
  else if (merchantId) match.merchantId = merchantId;
  if (livemode !== undefined) match.livemode = livemode ? true : { $ne: true };
  const [rows, cost] = await Promise.all([Transaction.aggregate(pipeline(match)), costs(match)]);
  return {
    period: { from: r.from.toISOString(), to: r.to.toISOString(), days: r.days },
    merchantId,
    ...summarize(rows),
    costs: cost,
  };
}

module.exports = { compute, summarize, pipeline, range, APPROVED, COST_SAMPLE };
