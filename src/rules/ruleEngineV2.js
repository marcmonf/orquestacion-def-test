'use strict';

/**
 * Rule Engine V2
 * - Política: { merchantId, version:'v1', defaultConnector, rules:[ { id, priority, when:{...}, action:{ route } } ], explain }
 * - Contexto (ctx): { bin, issuerCountry, scheme, cardType, currency, amount, latencyMs?, latencyP50?, successRate?, saturationPct?, costBps?, dayOfWeek?, hour? }
 * - Predicados soportados:
 *   • bin.inPrefixes: [ "4571", "4029" ]
 *   • scheme.in: [ "visa", "mastercard", "amex" ]
 *   • issuerCountry.in: [ "ES", "BR", ... ]
 *   • cardType.in: [ "credit", "debit", "prepaid", "corporate" ]
 *   • currency.in: [ "EUR", "USD", ... ]
 *   • amount.{lte,lt,eq,gt,gte}: number
 *   • latencyP50.lte OR latencyMs.lte: number (ms)            (ADV)
 *   • successRate.gte: 0..1                                    (ADV)
 *   • saturation.lt OR saturationPct.lt: 0..1                  (ADV)
 *   • costBps.lte: number (basis points)                       (ADV)
 *   • dayOfWeek.in: [0..6]  (0=Sunday)                         (GEN)
 *   • hour.inRange: [min,max]  (0..23)                         (GEN)
 *
 * - Flags:
 *   FEATURE_RULE_ENGINE_ADVANCED=1 habilita predicados ADV; si no, se ignoran silenciosamente.
 *
 * - Salida evaluate(policy, ctx, { explain }): {
 *     connector, matchedRuleId, reasons: string[], explain?: [{ruleId,type,expected,actual,ok}]
 *   }
 */

const FEATURE_RULE_ENGINE_ADVANCED = process.env.FEATURE_RULE_ENGINE_ADVANCED === '1';

function toLowerSafe(v) {
  return (typeof v === 'string') ? v.toLowerCase() : v;
}

function pick(ctx, keys) {
  for (const k of keys) {
    if (ctx[k] !== undefined && ctx[k] !== null) return ctx[k];
  }
  return undefined;
}

function inArray(actual, list) {
  if (!Array.isArray(list)) return false;
  const a = toLowerSafe(actual);
  return list.map(toLowerSafe).includes(a);
}

function startsWithAny(actual, prefixes) {
  if (!actual || !Array.isArray(prefixes)) return false;
  const s = String(actual);
  return prefixes.some(p => s.startsWith(String(p)));
}

function inRange(actual, range2) {
  if (!Array.isArray(range2) || range2.length !== 2) return false;
  const [min, max] = range2;
  if (typeof actual !== 'number') return false;
  return actual >= Number(min) && actual <= Number(max);
}

function cmpNumeric(actual, cond) {
  // cond: { lte, lt, eq, gt, gte }
  if (actual === undefined || actual === null) return false;
  if (cond.lte !== undefined && !(Number(actual) <= Number(cond.lte))) return false;
  if (cond.lt  !== undefined && !(Number(actual) <  Number(cond.lt)))  return false;
  if (cond.eq  !== undefined && !(Number(actual) === Number(cond.eq))) return false;
  if (cond.gt  !== undefined && !(Number(actual) >  Number(cond.gt)))  return false;
  if (cond.gte !== undefined && !(Number(actual) >= Number(cond.gte))) return false;
  return true;
}

function explainPush(explain, ruleId, type, expected, actual, ok) {
  explain.push({ ruleId, type, expected, actual, ok });
  return ok;
}

function checkPredicates(ruleId, when, ctx, explain, advEnabled) {
  // Básicos
  if (when.bin?.inPrefixes) {
    const ok = startsWithAny(ctx.bin, when.bin.inPrefixes);
    if (!explainPush(explain, ruleId, 'bin.inPrefixes', when.bin.inPrefixes, ctx.bin, ok)) return false;
  }
  if (when.scheme?.in) {
    const scheme = toLowerSafe(ctx.scheme);
    const ok = inArray(scheme, when.scheme.in);
    if (!explainPush(explain, ruleId, 'scheme.in', when.scheme.in, scheme, ok)) return false;
  }
  if (when.issuerCountry?.in) {
    const ok = inArray(ctx.issuerCountry, when.issuerCountry.in);
    if (!explainPush(explain, ruleId, 'issuerCountry.in', when.issuerCountry.in, ctx.issuerCountry, ok)) return false;
  }
  if (when.cardType?.in) {
    const ok = inArray(ctx.cardType, when.cardType.in);
    if (!explainPush(explain, ruleId, 'cardType.in', when.cardType.in, ctx.cardType, ok)) return false;
  }
  if (when.currency?.in) {
    const ok = inArray(ctx.currency, when.currency.in);
    if (!explainPush(explain, ruleId, 'currency.in', when.currency.in, ctx.currency, ok)) return false;
  }
  if (when.amount && typeof when.amount === 'object') {
    const ok = cmpNumeric(Number(ctx.amount), when.amount);
    if (!explainPush(explain, ruleId, 'amount.cmp', when.amount, ctx.amount, ok)) return false;
  }
  if (when.dayOfWeek?.in) {
    const dow = (ctx.dayOfWeek != null) ? ctx.dayOfWeek : (new Date()).getDay(); // 0..6
    const ok = Array.isArray(when.dayOfWeek.in) && when.dayOfWeek.in.includes(dow);
    if (!explainPush(explain, ruleId, 'dayOfWeek.in', when.dayOfWeek.in, dow, ok)) return false;
  }
  if (when.hour?.inRange) {
    const hr = (ctx.hour != null) ? ctx.hour : (new Date()).getHours();
    const ok = inRange(hr, when.hour.inRange);
    if (!explainPush(explain, ruleId, 'hour.inRange', when.hour.inRange, hr, ok)) return false;
  }

  // Avanzados (solo si flag)
  if (advEnabled) {
    if (when.latencyP50?.lte !== undefined || when.latencyMs?.lte !== undefined) {
      const actual = pick(ctx, ['latencyP50', 'latencyMs']);
      const limit = when.latencyP50?.lte ?? when.latencyMs?.lte;
      const ok = actual !== undefined && Number(actual) <= Number(limit);
      if (!explainPush(explain, ruleId, 'latencyP50.lte', limit, actual, ok)) return false;
    }
    if (when.successRate?.gte !== undefined) {
      const actual = ctx.successRate;
      const limit = when.successRate.gte;
      const ok = actual !== undefined && Number(actual) >= Number(limit);
      if (!explainPush(explain, ruleId, 'successRate.gte', limit, actual, ok)) return false;
    }
    if ((when.saturation?.lt !== undefined) || (when.saturationPct?.lt !== undefined)) {
      const actual = pick(ctx, ['saturation', 'saturationPct']);
      const limit = when.saturation?.lt ?? when.saturationPct?.lt;
      const ok = actual !== undefined && Number(actual) < Number(limit);
      if (!explainPush(explain, ruleId, 'saturation.lt', limit, actual, ok)) return false;
    }
    if (when.costBps?.lte !== undefined) {
      const actual = ctx.costBps;
      const limit = when.costBps.lte;
      const ok = actual !== undefined && Number(actual) <= Number(limit);
      if (!explainPush(explain, ruleId, 'costBps.lte', limit, actual, ok)) return false;
    }
  } else {
    // Si el flag no está activo, ignoramos silenciosamente esos predicados pero
    // dejamos constancia en la explicación para diagnóstico.
    const advKeys = ['latencyP50','latencyMs','successRate','saturation','saturationPct','costBps'];
    for (const k of advKeys) {
      if (when[k]) explainPush(explain, ruleId, `${k}.* (ignored)`, when[k], undefined, true);
    }
  }

  return true;
}

function sortRules(rules) {
  return [...(rules || [])].sort((a, b) => {
    const pa = a.priority ?? 0;
    const pb = b.priority ?? 0;
    return pa - pb || String(a.id || '').localeCompare(String(b.id || ''));
  });
}

function evaluate(policy, ctx = {}, options = {}) {
  const explain = [];
  const reasons = [];
  const rules = sortRules(policy.rules);

  for (const rule of rules) {
    const ok = checkPredicates(rule.id || null, rule.when || {}, ctx, explain, FEATURE_RULE_ENGINE_ADVANCED);
    if (ok) {
      const connector = rule?.action?.route || policy.defaultConnector;
      reasons.push(`matched rule ${rule.id || '(no-id)'} → ${connector}`);
      return options.explain
        ? { connector, matchedRuleId: rule.id || null, reasons, explain }
        : { connector, matchedRuleId: rule.id || null, reasons };
    } else {
      reasons.push(`rule ${rule.id || '(no-id)'} not matched`);
    }
  }

  const connector = policy.defaultConnector;
  reasons.push(`no rule matched → default ${connector}`);
  return options.explain
    ? { connector, matchedRuleId: null, reasons, explain }
    : { connector, matchedRuleId: null, reasons };
}

module.exports = { evaluate };
