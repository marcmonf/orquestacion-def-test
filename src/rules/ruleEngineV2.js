'use strict';

function inArray(val, set) {
  if (!Array.isArray(set)) return false;
  return set.includes(val);
}

function cmpNumber(n, bounds = {}) {
  if (typeof n !== 'number') return false;
  if (typeof bounds.gte === 'number' && !(n >= bounds.gte)) return false;
  if (typeof bounds.lt === 'number' && !(n < bounds.lt)) return false;
  if (typeof bounds.lte === 'number' && !(n <= bounds.lte)) return false;
  if (typeof bounds.gt === 'number' && !(n > bounds.gt)) return false;
  return true;
}

function matchWhen(when, ctx, trace) {
  const checks = [];

  if (when.bin && when.bin.in) {
    const ok = inArray(String(ctx.bin || '').slice(0, 6), when.bin.in);
    checks.push({ field: 'bin', ok, rule: when.bin.in });
  }
  if (when.issuerCountry && when.issuerCountry.in) {
    const ok = inArray(ctx.issuerCountry, when.issuerCountry.in);
    checks.push({ field: 'issuerCountry', ok, rule: when.issuerCountry.in });
  }
  if (when.scheme && when.scheme.in) {
    const ok = inArray(ctx.scheme, when.scheme.in);
    checks.push({ field: 'scheme', ok, rule: when.scheme.in });
  }
  if (when.cardType && when.cardType.in) {
    const ok = inArray(ctx.cardType, when.cardType.in);
    checks.push({ field: 'cardType', ok, rule: when.cardType.in });
  }
  if (when.currency && when.currency.in) {
    const ok = inArray(ctx.currency, when.currency.in);
    checks.push({ field: 'currency', ok, rule: when.currency.in });
  }
  if (when.region && when.region.in) {
    const ok = inArray(ctx.region, when.region.in);
    checks.push({ field: 'region', ok, rule: when.region.in });
  }
  if (when.amount) {
    const ok = cmpNumber(Number(ctx.amount), when.amount);
    checks.push({ field: 'amount', ok, rule: when.amount });
  }
  if (when.latencyMs) {
    const ok = cmpNumber(Number(ctx.latencyMs || 0), when.latencyMs);
    checks.push({ field: 'latencyMs', ok, rule: when.latencyMs });
  }
  if (when.costBps) {
    const ok = cmpNumber(Number(ctx.costBps || 0), when.costBps);
    checks.push({ field: 'costBps', ok, rule: when.costBps });
  }
  if (when.fraudScore) {
    const ok = cmpNumber(Number(ctx.fraudScore || 0), when.fraudScore);
    checks.push({ field: 'fraudScore', ok, rule: when.fraudScore });
  }

  const allOk = checks.every(c => c.ok !== false);
  if (trace) trace.push(...checks);
  return allOk;
}

function evaluate(policy, ctx, { explain = true } = {}) {
  if (!policy || !Array.isArray(policy.rules)) {
    return {
      connector: policy?.defaultConnector || null,
      matchedRuleId: null,
      reasons: ['no_rules'],
      explain: []
    };
  }

  const ordered = [...policy.rules].sort((a, b) => a.priority - b.priority);
  for (const rule of ordered) {
    const explainTrace = [];
    const ok = matchWhen(rule.when || {}, ctx, explain ? explainTrace : null);
    if (ok) {
      return {
        connector: rule.action?.route || policy.defaultConnector || null,
        matchedRuleId: rule.id,
        reasons: ['matched_conditions'],
        explain: explain ? explainTrace : []
      };
    }
  }
  return {
    connector: policy.defaultConnector || null,
    matchedRuleId: null,
    reasons: ['no_match_default'],
    explain: []
  };
}

module.exports = { evaluate };
