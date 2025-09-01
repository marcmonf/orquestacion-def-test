'use strict';

/**
 * Motor de reglas determinista y trazable.
 * - Prioridad: mayor primero.
 * - Condiciones soportadas (when):
 *   - currency.in:        ["EUR","USD"]
 *   - issuerCountry.in:   ["ES","BR"]
 *   - scheme.in:          ["visa","mastercard"]
 *   - cardType.in:        ["debit","credit","prepaid"]
 *   - bin.inPrefixes:     ["4571","4029","411111"]
 *   - amount:             { lt, gt, lte, gte }
 *   - latencyMs:          { lt, gt, lte, gte }       // latencia histórica agregada del contexto
 *   - costBps:            { lt, gt, lte, gte }       // coste medio simulado en basis points
 *   - saturationPct:      { lt, gt, lte, gte }       // saturación estimada 0-100
 *
 * Salida:
 *   { connector, matchedRuleId|null, reasons[], explain[] }
 */

function _numOk(op, val, cmp) {
  if (typeof val !== 'number' || typeof cmp !== 'number') return false;
  switch (op) {
    case 'lt':  return val <  cmp;
    case 'gt':  return val >  cmp;
    case 'lte': return val <= cmp;
    case 'gte': return val >= cmp;
    default:    return false;
  }
}

function _cmpNumberBlock(val, block = {}) {
  const ops = ['lt','gt','lte','gte'];
  const results = [];
  for (const op of ops) {
    if (block[op] !== undefined) {
      const ok = _numOk(op, val, block[op]);
      results.push({ type: `number.${op}`, expected: block[op], actual: val, ok });
      if (!ok) return { ok: false, details: results };
    }
  }
  return { ok: true, details: results };
}

function _inCaseInsensitive(value, arr = []) {
  const v = String(value || '').toLowerCase();
  return arr.some(x => String(x || '').toLowerCase() === v);
}

function _checkIn(label, value, arr) {
  const ok = _inCaseInsensitive(value, arr);
  return { ok, details: [{ type: `${label}.in`, expected: arr, actual: value, ok }] };
}

function _checkBinPrefixes(bin, prefixes = []) {
  const b = String(bin || '');
  const ok = prefixes.some(p => b.startsWith(String(p)));
  return { ok, details: [{ type: 'bin.inPrefixes', expected: prefixes, actual: bin, ok }] };
}

function _evalWhen(when, ctx) {
  const details = [];
  let ok = true;

  if (when.currency?.in) {
    const r = _checkIn('currency', ctx.currency, when.currency.in);
    details.push(...r.details); ok = ok && r.ok;
  }
  if (when.issuerCountry?.in) {
    const r = _checkIn('issuerCountry', ctx.issuerCountry, when.issuerCountry.in);
    details.push(...r.details); ok = ok && r.ok;
  }
  if (when.scheme?.in) {
    const r = _checkIn('scheme', ctx.scheme, when.scheme.in);
    details.push(...r.details); ok = ok && r.ok;
  }
  if (when.cardType?.in) {
    const r = _checkIn('cardType', ctx.cardType, when.cardType.in);
    details.push(...r.details); ok = ok && r.ok;
  }
  if (when.bin?.inPrefixes) {
    const r = _checkBinPrefixes(ctx.bin, when.bin.inPrefixes);
    details.push(...r.details); ok = ok && r.ok;
  }
  if (when.amount) {
    const r = _cmpNumberBlock(ctx.amount, when.amount);
    details.push(...r.details); ok = ok && r.ok;
  }
  if (when.latencyMs) {
    const r = _cmpNumberBlock(ctx.latencyMs, when.latencyMs);
    details.push(...r.details); ok = ok && r.ok;
  }
  if (when.costBps) {
    const r = _cmpNumberBlock(ctx.costBps, when.costBps);
    details.push(...r.details); ok = ok && r.ok;
  }
  if (when.saturationPct) {
    const r = _cmpNumberBlock(ctx.saturationPct, when.saturationPct);
    details.push(...r.details); ok = ok && r.ok;
  }

  return { ok, details };
}

/**
 * evaluate(policy, ctx, opts)
 * - policy: { defaultConnector, rules[], explain:boolean }
 * - ctx:    ver README arriba
 * - opts:   { explain?: boolean }
 */
function evaluate(policy = {}, ctx = {}, opts = {}) {
  const explainWanted = (opts.explain ?? policy.explain) === true;
  const rules = Array.isArray(policy.rules) ? [...policy.rules] : [];
  rules.sort((a, b) => (b.priority || 0) - (a.priority || 0));

  for (const rule of rules) {
    const when = rule.when || {};
    const check = _evalWhen(when, ctx);

    if (check.ok) {
      return {
        connector: rule.action?.route || 'auto',
        matchedRuleId: rule.id || null,
        reasons: ['matched_rule'],
        explain: explainWanted ? check.details : []
      };
    }
  }

  return {
    connector: policy.defaultConnector || 'auto',
    matchedRuleId: null,
    reasons: ['no_match_default'],
    explain: []
  };
}

module.exports = { evaluate };
