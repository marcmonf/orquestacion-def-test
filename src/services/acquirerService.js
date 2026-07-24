// src/services/acquirerService.js
'use strict';
//
// Adquirentes (M7 Bloque 2): catálogo global, fichas por merchant y RESOLUCIÓN de
// routing estático. Multi-adquirente (N); hoy solo Paylands procesa en vivo.
//
const Acquirer            = require('../models/Acquirer');
const MerchantAcquirer    = require('../models/MerchantAcquirer');
const MerchantRoutingRule = require('../models/MerchantRoutingRule');
const { DEFAULT_ACQUIRERS } = require('../utils/acquirerDefaults');

async function getCatalog() {
  const docs = await Acquirer.find({}).lean();
  if (docs && docs.length) return docs.map(d => ({ ...d, source: 'saved' }));
  return DEFAULT_ACQUIRERS.map(a => ({ ...a, source: 'default' }));
}

async function getAcquirer(code) {
  const doc = await Acquirer.findOne({ code });
  if (doc) return doc.toObject ? doc.toObject() : doc;
  return DEFAULT_ACQUIRERS.find(a => a.code === code) || null;
}

async function getMerchantAcquirers(merchantId) {
  return MerchantAcquirer.find({ merchantId }).sort({ priority: 1 }).lean();
}

async function getMerchantRules(merchantId) {
  return MerchantRoutingRule.find({ merchantId }).sort({ priority: 1 }).lean();
}

// ¿la regla casa con el contexto de tarjeta? (criterios en AND; vacío = comodín)
function matchesRule(rule, ctx) {
  if (rule.active === false) return false;
  if (rule.binPrefix && !String(ctx.bin || '').startsWith(rule.binPrefix)) return false;
  if (rule.scheme && String(rule.scheme).toLowerCase() !== String(ctx.scheme).toLowerCase()) return false;
  if (rule.cardType && String(rule.cardType).toLowerCase() !== String(ctx.cardType).toLowerCase()) return false;
  if (rule.issuerCountry && String(rule.issuerCountry).toUpperCase() !== String(ctx.issuerCountry).toUpperCase()) return false;
  if (rule.amountMin != null && ctx.amount < rule.amountMin) return false;
  if (rule.amountMax != null && ctx.amount > rule.amountMax) return false;
  return true;
}

// Resuelve el adquirente para un contexto según las reglas del merchant; si ninguna
// casa, usa el adquirente por defecto. { acquirerCode, matchedRuleId, reason }.
async function resolveRouting(merchantId, ctx) {
  const rules = await getMerchantRules(merchantId);
  for (const r of rules) {
    if (matchesRule(r, ctx)) return { acquirerCode: r.acquirerCode, matchedRuleId: String(r._id), reason: 'rule' };
  }
  const mas = await getMerchantAcquirers(merchantId);
  const def = mas.find(m => m.isDefault && m.active !== false) || mas.find(m => m.active !== false);
  if (def) return { acquirerCode: def.acquirerCode, matchedRuleId: null, reason: 'default' };
  return { acquirerCode: null, matchedRuleId: null, reason: 'none' };
}

module.exports = { getCatalog, getAcquirer, getMerchantAcquirers, getMerchantRules, matchesRule, resolveRouting };
