// src/services/costService.js
'use strict';
//
// Motor de COSTE REAL por transacción (M7 Bloque 2 — el "WOW" para finance).
// Coste efectivo = interchange + scheme fees (CSF) + margen del adquirente (ICH++)
//                + fee de la pasarela (contrato del merchant).
//
// SIEMPRE APROXIMADO: interchange y scheme fees los fijan las marcas (VISA/MC), no
// el adquirente ni la pasarela. Ver COST_DISCLAIMER.
//
const Transaction     = require('../models/Transaction');
const InterchangeRate = require('../models/InterchangeRate');
const billingService  = require('./billingService');
const acquirerService = require('./acquirerService');
const { fromTransaction } = require('../utils/cardContext');
const { DEFAULT_INTERCHANGE, COST_DISCLAIMER, findInterchange } = require('../utils/interchangeDefaults');

function pct(amount, bps) { return Math.round((Number(amount) || 0) * (Number(bps) || 0) / 10000); }

async function getInterchangeTable() {
  const docs = await InterchangeRate.find({}).lean();
  return (docs && docs.length) ? docs : DEFAULT_INTERCHANGE;
}

// Coste de UN contexto de tarjeta ({ amount, scheme, cardType, region, ... }).
function estimateForContext(ctx, { acquirer, merchantAcquirer, interchangeRows, gatewayPerTx = 0 }) {
  const amount = Number(ctx.amount) || 0;
  const ic = findInterchange(interchangeRows || [], ctx);
  const interchange = ic ? pct(amount, ic.bps) + (ic.fixed || 0) : 0;

  let schemeFee = 0;
  if (acquirer && Array.isArray(acquirer.schemeFees)) {
    const sf = acquirer.schemeFees.find(s => String(s.cardType).toLowerCase() === String(ctx.cardType).toLowerCase());
    if (sf) schemeFee = pct(amount, sf.bps) + (sf.fixed || 0);
  }

  const acquirerMarkup = merchantAcquirer
    ? pct(amount, merchantAcquirer.markupBps || 0) + (merchantAcquirer.fixedFee || 0)
    : 0;

  const gatewayFee = Number(gatewayPerTx) || 0;
  const total = interchange + schemeFee + acquirerMarkup + gatewayFee;
  return {
    amount, scheme: ctx.scheme, cardType: ctx.cardType, region: ctx.region,
    interchange, schemeFee, acquirerMarkup, gatewayFee, total,
    effectiveRatePct: amount ? Number((total / amount * 100).toFixed(3)) : 0,
  };
}

// Coste estimado del PERÍODO de un merchant (media efectiva + muestra por tx).
async function estimateForMerchant(merchant, period) {
  const range = billingService.periodRange(period);
  if (!range) throw Object.assign(new Error('invalid_period'), { code: 'invalid_period' });

  const [interchangeRows, mas, config] = await Promise.all([
    getInterchangeTable(),
    acquirerService.getMerchantAcquirers(merchant.merchantId),
    billingService.resolveConfig(merchant),
  ]);
  const gatewayPerTx = config.perTransactionFee || 0;
  const defMa = mas.find(m => m.isDefault && m.active !== false) || mas.find(m => m.active !== false) || null;
  const acquirer = defMa ? await acquirerService.getAcquirer(defMa.acquirerCode) : null;

  const txs = await Transaction.find({
    merchantId: merchant.merchantId,
    status: { $in: billingService.BILLABLE_STATUSES },
    createdAt: { $gte: range.start, $lt: range.end },
  }).limit(5000).lean();

  let totalAmount = 0, totalCost = 0, count = 0;
  const sample = [];
  for (const tx of txs) {
    const ctx = fromTransaction(tx, merchant.country);
    const est = estimateForContext(ctx, { acquirer, merchantAcquirer: defMa, interchangeRows, gatewayPerTx });
    totalAmount += ctx.amount; totalCost += est.total; count++;
    if (sample.length < 10) sample.push({ paymentId: tx.paymentId, ...est });
  }

  return {
    period, merchantId: merchant.merchantId, currency: config.currency || 'EUR',
    acquirerCode: defMa ? defMa.acquirerCode : null,
    transactions: count, totalVolume: totalAmount, totalCost,
    avgCostPerTx: count ? Math.round(totalCost / count) : 0,
    effectiveRatePct: totalAmount ? Number((totalCost / totalAmount * 100).toFixed(3)) : 0,
    sample, disclaimer: COST_DISCLAIMER,
  };
}

module.exports = { getInterchangeTable, estimateForContext, estimateForMerchant, COST_DISCLAIMER };
