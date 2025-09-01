'use strict';

const Joi = require('joi');
const { evaluate } = require('../rules/ruleEngineV2');
const MerchantRules = require('../models/MerchantRules');
const { parseBin } = require('../utils/cardInfoParser');
const metrics = require('../orchestrator/metrics/metricsService');

// Esquema de entrada mínimo para decisión
const decideSchema = Joi.object({
  paymentId: Joi.string().optional(),
  merchantId: Joi.string().required(),
  amount: Joi.number().positive().required(),
  currency: Joi.string().length(3).required(),
  method: Joi.string().required().valid('card', 'apm'),
  // Para enriquecimiento básico si aún llega PAN en dev (no almacenar)
  cardNumber: Joi.string().creditCard().optional(),
  cardInfo: Joi.object().optional() // si ya lo traes enriquecido
});

async function loadPolicy(merchantId) {
  const doc = await MerchantRules.findOne({ merchantId }).lean();
  if (doc && doc.policy) return doc.policy;

  // Política por defecto segura: conector 'dummyCard' salvo regla explícita
  return {
    merchantId,
    version: 'v1',
    defaultConnector: 'dummyCard',
    rules: [], // puedes insertar reglas luego vía UI/DB
    fallback: { order: ['dummyCard'], on: ['network_error', 'soft_decline'] },
    retries: { soft_decline: 1, network_error: 2, jitterMs: [200, 500] },
    explain: true
  };
}

function toCtx(input, enriched) {
  const bin = enriched?.bin || (input.cardNumber ? String(input.cardNumber).slice(0, 6) : null);
  return {
    bin,
    issuerCountry: enriched?.issuerCountry || null,
    scheme: enriched?.cardBrand || enriched?.scheme || null,
    cardType: enriched?.cardType || null,
    currency: input.currency,
    region: enriched?.region || null,
    amount: input.amount,
    latencyMs: undefined,
    costBps: undefined,
    fraudScore: undefined
  };
}

async function decideRoute(req, res) {
  const { error, value } = decideSchema.validate(req.body);
  if (error) return res.status(400).json({ success: false, error: error.details[0].message });

  try {
    // Enriquecimiento BIN opcional
    let enriched = value.cardInfo || null;
    if (!enriched && value.cardNumber) {
      try { enriched = await parseBin(value.cardNumber); } catch {}
    }

    const policy = await loadPolicy(value.merchantId);
    const decision = evaluate(policy, toCtx(value, enriched), { explain: policy.explain });

    // Si la acción pide auto-selección por métricas, elegir entre candidatos (a futuro)
    let connector = decision.connector || policy.defaultConnector || 'dummyCard';
    if (connector === 'auto') {
      const list = Array.isArray(policy.fallback?.order) && policy.fallback.order.length
        ? policy.fallback.order
        : ['dummyCard'];
      connector = metrics.pickBest(list, { maxLatencyMs: undefined, minSuccessRate: 0.0 }) || list[0];
    }

    const response = {
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
    };

    return res.status(200).json(response);
  } catch (e) {
    return res.status(500).json({ success: false, error: 'internal_error', detail: e.message });
  }
}

module.exports = { decideRoute };
