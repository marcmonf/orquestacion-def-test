'use strict';

const crypto = require('crypto');
const MerchantRules = require('../models/MerchantRules');
const RuleAudit = require('../models/RuleAudit');
const { policySchema } = require('../validators/policySchema');
const { evaluate } = require('../rules/ruleEngineV2');
const { parseBin } = require('../utils/cardInfoParser');
const metrics = require('../orchestrator/metrics/metricsService');

const FEATURE_RULE_TRY = process.env.FEATURE_RULE_TRY === '1';
const FEATURE_RULE_AUDIT = process.env.FEATURE_RULE_AUDIT === '1';
const FEATURE_RULE_EXPORT_UI = process.env.FEATURE_RULE_EXPORT_UI === '1';

function defaultPolicy(merchantId) {
  return {
    merchantId,
    version: 'v1',
    defaultConnector: 'dummyCard',
    rules: [],
    fallback: { order: ['dummyCard'], on: ['network_error','soft_decline'] },
    retries: { soft_decline: 1, network_error: 2, jitterMs: [200,500] },
    explain: true
  };
}

async function getPolicy(req, res) {
  const { merchantId } = req.params;
  const doc = await MerchantRules.findOne({ merchantId }).lean();
  const policy = doc?.policy || defaultPolicy(merchantId);
  return res.status(200).json({ success: true, policy });
}

async function validatePolicy(req, res) {
  const { error, value } = policySchema.validate(req.body, { abortEarly: false });
  if (error) {
    return res.status(400).json({
      success: false,
      errors: error.details.map(d => ({ path: d.path.join('.'), message: d.message }))
    });
  }
  return res.status(200).json({ success: true, normalized: value });
}

function _hash(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex');
}
function _diffFields(prev, next) {
  const fields = new Set();
  const pk = Object.keys(prev || {});
  const nk = Object.keys(next || {});
  for (const k of new Set([...pk, ...nk])) {
    if (JSON.stringify(prev?.[k]) !== JSON.stringify(next?.[k])) fields.add(k);
  }
  return [...fields];
}

async function upsertPolicy(req, res) {
  const { merchantId } = req.params;
  const body = { ...req.body, merchantId };
  const { error, value } = policySchema.validate(body, { abortEarly: false });
  if (error) {
    return res.status(400).json({
      success: false,
      errors: error.details.map(d => ({ path: d.path.join('.'), message: d.message }))
    });
  }
  const now = new Date();
  const existing = await MerchantRules.findOne({ merchantId }).lean();
  const updated = await MerchantRules.findOneAndUpdate(
    { merchantId },
    { $set: { policy: value, updatedAt: now }, $setOnInsert: { createdAt: now } },
    { new: true, upsert: true }
  ).lean();

  if (FEATURE_RULE_AUDIT) {
    try {
      const prev = existing?.policy || null;
      const next = updated.policy;
      await RuleAudit.create({
        merchantId,
        actor: req.header('x-admin-actor') || 'unknown',
        ip: (req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket?.remoteAddress || null,
        prevHash: _hash(prev || {}),
        nextHash: _hash(next || {}),
        diffSize: Math.abs(JSON.stringify(next).length - JSON.stringify(prev || {}).length),
        changedFields: _diffFields(prev || {}, next || {})
      });
    } catch (_) {}
  }
  return res.status(200).json({ success: true, policy: updated.policy });
}

async function tryPolicy(req, res) {
  if (!FEATURE_RULE_TRY) return res.status(404).json({ success: false, error: 'disabled' });

  const { policy, sample } = req.body || {};
  const { error } = policySchema.validate(policy || {}, { abortEarly: false });
  if (error) {
    return res.status(400).json({
      success: false,
      errors: error.details.map(d => ({ path: d.path.join('.'), message: d.message }))
    });
  }

  // Enriquecer con BIN si viene PAN (salta si BIN_OFFLINE=1 y no hay red)
  let enriched = sample?.cardInfo || null;
  if (!enriched && sample?.cardNumber) {
    try { enriched = await parseBin(sample.cardNumber); } catch {}
  }

  // Métricas: sample.metrics tiene prioridad; sino rolling stats
  const roll = (typeof metrics.getRollingStats === 'function') ? (metrics.getRollingStats() || {}) : {};
  const m = sample?.metrics || {};
  const ctx = {
    bin: enriched?.bin || (sample?.cardNumber ? String(sample.cardNumber).slice(0,6) : null),
    issuerCountry: enriched?.issuerCountry || null,
    scheme: enriched?.cardBrand || enriched?.scheme || null,
    cardType: enriched?.cardType || null,
    currency: sample?.currency,
    amount: sample?.amount,
    latencyP50: m.latencyP50 ?? roll.p50Latency,
    latencyMs:  m.latencyMs  ?? roll.p50Latency,
    successRate: m.successRate ?? roll.successRate,
    saturationPct: m.saturationPct ?? roll.saturationPct,
    costBps: m.costBps ?? roll.avgCostBps,
    dayOfWeek: sample?.dayOfWeek,
    hour: sample?.hour
  };

  const decision = evaluate(policy, ctx, { explain: true });
  const nice = decision.explain.map(e => {
    const ok = e.ok ? '✔' : '✖';
    if (e.type.endsWith('.in') || e.type === 'bin.inPrefixes') {
      return `${ok} ${e.type}: esperado ${JSON.stringify(e.expected)} · actual ${JSON.stringify(e.actual)}`;
    }
    return `${ok} ${e.type}: ${e.actual} vs ${e.expected}`;
  });

  return res.status(200).json({
    success: true,
    decision: {
      connector: decision.connector,
      matchedRuleId: decision.matchedRuleId,
      reasons: decision.reasons
    },
    explainHuman: nice
  });
}

async function getAudit(req, res) {
  if (!FEATURE_RULE_AUDIT) return res.status(404).json({ success: false, error: 'disabled' });
  const { merchantId } = req.params;
  const limit = Math.max(1, Math.min(100, parseInt(req.query.limit || '20', 10)));
  const offset = Math.max(0, parseInt(req.query.offset || '0', 10));

  const [total, items] = await Promise.all([
    RuleAudit.countDocuments({ merchantId }),
    RuleAudit.find({ merchantId }).sort({ createdAt: -1 }).skip(offset).limit(limit).lean()
  ]);

  return res.status(200).json({ success: true, total, items });
}

/* ------------------------- EXPORT / IMPORT ------------------------- */
async function exportPolicy(req, res) {
  if (!FEATURE_RULE_EXPORT_UI) return res.status(404).json({ success: false, error: 'disabled' });
  const merchantId = String(req.query.merchantId || '').trim();
  if (!merchantId) return res.status(400).json({ success: false, error: 'merchantId required' });

  const doc = await MerchantRules.findOne({ merchantId }).lean();
  const policy = doc?.policy || defaultPolicy(merchantId);
  const payload = {
    merchantId: policy.merchantId,
    version: policy.version || 'v1',
    defaultConnector: policy.defaultConnector,
    rules: policy.rules || []
  };
  const hash = _hash(payload);
  return res.status(200).json({ success: true, export: { ...payload, hash } });
}

async function importPolicy(req, res) {
  if (!FEATURE_RULE_EXPORT_UI) return res.status(404).json({ success: false, error: 'disabled' });

  const { error, value } = policySchema.validate(req.body || {}, { abortEarly: false });
  if (error) {
    return res.status(400).json({
      success: false,
      errors: error.details.map(d => ({ path: d.path.join('.'), message: d.message }))
    });
  }

  // Verificar hash si el cliente lo envía
  const expected = _hash({
    merchantId: value.merchantId,
    version: value.version,
    defaultConnector: value.defaultConnector,
    rules: value.rules
  });
  if (req.body.hash && req.body.hash !== expected) {
    return res.status(400).json({ success: false, error: 'hash mismatch' });
  }

  const now = new Date();
  const existing = await MerchantRules.findOne({ merchantId: value.merchantId }).lean();
  const updated = await MerchantRules.findOneAndUpdate(
    { merchantId: value.merchantId },
    { $set: { policy: value, updatedAt: now }, $setOnInsert: { createdAt: now } },
    { new: true, upsert: true }
  ).lean();

  if (FEATURE_RULE_AUDIT) {
    try {
      const prev = existing?.policy || null;
      const next = updated.policy;
      await RuleAudit.create({
        merchantId: value.merchantId,
        actor: req.header('x-admin-actor') || 'unknown',
        ip: (req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket?.remoteAddress || null,
        prevHash: _hash(prev || {}),
        nextHash: _hash(next || {}),
        diffSize: Math.abs(JSON.stringify(next).length - JSON.stringify(prev || {}).length),
        changedFields: _diffFields(prev || {}, next || {})
      });
    } catch (_) {}
  }

  return res.status(200).json({ success: true, policy: updated.policy });
}

module.exports = {
  getPolicy, validatePolicy, upsertPolicy, tryPolicy, getAudit,
  exportPolicy, importPolicy
};
