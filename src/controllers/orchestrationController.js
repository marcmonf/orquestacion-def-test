'use strict';

const Joi = require('joi');
const { evaluate } = require('../rules/ruleEngineV2');
const MerchantRules = require('../models/MerchantRules');
const { parseBin } = require('../utils/cardInfoParser');
const metrics = require('../orchestrator/metrics/metricsService');
const { DEFAULT_CONNECTOR } = require('../services/connectorRegistry');

const FEATURE_RULE_ENGINE_ADVANCED = process.env.FEATURE_RULE_ENGINE_ADVANCED === '1';

const decideSchema = Joi.object({
  paymentId: Joi.string().optional(),
  merchantId: Joi.string().required(),
  amount: Joi.number().positive().required(),
  currency: Joi.string().length(3).required(),
  method: Joi.string().required().valid('card', 'apm'),
  // Solo el BIN (6-8 dígitos). Un PAN completo nunca debe llegar al servidor.
  bin: Joi.string().pattern(/^\d{6,8}$/).optional(),
  cardInfo: Joi.object().optional()
});

async function loadPolicy(merchantId) {
  const doc = await MerchantRules.findOne({ merchantId }).lean();
  if (doc && doc.policy) return doc.policy;
  return {
    merchantId,
    version: 'v1',
    defaultConnector: DEFAULT_CONNECTOR,
    rules: [],
    retries: { soft_decline: 0, network_error: 0, jitterMs: [200, 500] },
    explain: true
  };
}

function toCtx(input, enriched) {
  const bin = enriched?.bin || input.bin || null;
  const base = {
    bin,
    issuerCountry: enriched?.issuerCountry || null,
    scheme: enriched?.cardBrand || enriched?.scheme || null,
    cardType: enriched?.cardType || null,
    currency: input.currency,
    amount: input.amount
  };

  if (!FEATURE_RULE_ENGINE_ADVANCED) return base;

  // Métricas globales para condiciones avanzadas
  const roll = metrics.getRollingStats();
  return {
    ...base,
    latencyMs: roll.p50Latency ?? undefined,
    costBps: roll.avgCostBps ?? undefined,
    saturationPct: roll.saturationPct ?? undefined
  };
}

async function decideRoute(req, res) {
  const { error, value } = decideSchema.validate(req.body);
  if (error) return res.status(400).json({ success: false, error: error.details[0].message });

  try {
    let enriched = value.cardInfo || null;
    if (!enriched && value.bin) {
      try { enriched = await parseBin(value.bin); } catch {}
    }

    const policy = await loadPolicy(value.merchantId);
    const ctx = toCtx(value, enriched);
    const decision = evaluate(policy, ctx, { explain: policy.explain });

    let connector = decision.connector || policy.defaultConnector || DEFAULT_CONNECTOR;
    if (connector === 'auto') {
      const list = Array.isArray(policy.fallback?.order) && policy.fallback.order.length
        ? policy.fallback.order
        : [DEFAULT_CONNECTOR];
      connector = metrics.pickBest(list, { maxLatencyMs: undefined, minSuccessRate: 0.0 }) || list[0];
    }

    return res.status(200).json({
      success: true,
      paymentId: value.paymentId || null,
      decision: {
        connector,
        matchedRuleId: decision.matchedRuleId,
        reasons: decision.reasons,
        explain: decision.explain
      },
      cardInfo: enriched ? {
        bin: enriched.bin || null,
        cardBrand: enriched.cardBrand || enriched.scheme || null,
        cardType: enriched.cardType || null,
        issuerCountry: enriched.issuerCountry || null
      } : null,
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    console.error('❌ [orchestration/decide]', e && e.message);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
}

module.exports = { decideRoute };
