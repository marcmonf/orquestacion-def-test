'use strict';

/**
 * Métricas en memoria. Sin dependencias externas.
 * - recordAttempt(connectorId, { ok, latencyMs, costBps })
 * - getRollingStats(): agregados globales
 * - getSaturation(): saturación estimada global 0-100
 * - pickBest(list, criteria): elige conector con score
 */

const MAX_SAMPLES = 256;
const WINDOW_MS = 60_000;

const state = new Map(); // connectorId -> { latencies[], costs[], attempts[], okCount, lastSeen[] }

function _ensure(id) {
  if (!state.has(id)) {
    state.set(id, {
      latencies: [],
      costs: [],
      attempts: [],
      okCount: 0
    });
  }
  return state.get(id);
}

function recordAttempt(id, { ok, latencyMs, costBps }) {
  const s = _ensure(id);
  const now = Date.now();

  if (typeof latencyMs === 'number') {
    s.latencies.push({ t: now, v: latencyMs });
    if (s.latencies.length > MAX_SAMPLES) s.latencies.shift();
  }
  if (typeof costBps === 'number') {
    s.costs.push({ t: now, v: costBps });
    if (s.costs.length > MAX_SAMPLES) s.costs.shift();
  }
  s.attempts.push({ t: now, ok: !!ok });
  if (s.attempts.length > MAX_SAMPLES) s.attempts.shift();
  if (ok) s.okCount++;
}

function _withinWindow(arr) {
  const cutoff = Date.now() - WINDOW_MS;
  return arr.filter(x => x.t >= cutoff);
}

function _p(arr, p) {
  if (!arr.length) return undefined;
  const vals = arr.map(x => x.v).sort((a,b)=>a-b);
  const idx = Math.max(0, Math.min(vals.length - 1, Math.floor((p/100)*vals.length) - 1));
  return vals[idx];
}

function _avg(arr) {
  if (!arr.length) return undefined;
  return arr.reduce((a,b)=>a + b.v, 0) / arr.length;
}

function _qps(attempts) {
  const ws = _withinWindow(attempts);
  return ws.length / (WINDOW_MS / 1000);
}

function _capacityFor(id) {
  const key = `SIM_CAPACITY_${String(id || '').toUpperCase()}`;
  const v = parseInt(process.env[key] || '100', 10);
  return isFinite(v) && v > 0 ? v : 100;
}

function statsByConnector() {
  const res = {};
  for (const [id, s] of state.entries()) {
    const lat = _withinWindow(s.latencies);
    const costs = _withinWindow(s.costs);
    const atts = _withinWindow(s.attempts);

    const p50Latency = _p(lat, 50);
    const p95Latency = _p(lat, 95);
    const avgCostBps = _avg(costs);
    const qps = _qps(atts);
    const saturationPct = Math.min(100, Math.round((qps / _capacityFor(id)) * 100));
    const ok = atts.filter(a => a.ok).length;
    const successRate = atts.length ? ok / atts.length : undefined;

    res[id] = { p50Latency, p95Latency, avgCostBps, saturationPct, successRate };
  }
  return res;
}

function getRollingStats() {
  const by = statsByConnector();
  // Agregado global: toma mínimos/medios razonables
  const all = Object.values(by);
  const p50Latency = _avg(all.map(v => ({ v: v.p50Latency ?? 0 }))) ?? undefined;
  const avgCostBps = _avg(all.map(v => ({ v: v.avgCostBps ?? 0 }))) ?? undefined;
  const saturationPct = _avg(all.map(v => ({ v: v.saturationPct ?? 0 }))) ?? undefined;
  return { p50Latency, avgCostBps, saturationPct, byConnector: by };
}

function getSaturation() {
  const { saturationPct = 0 } = getRollingStats();
  return saturationPct ?? 0;
}

function pickBest(list = [], { maxLatencyMs, minSuccessRate = 0.0 } = {}) {
  const by = statsByConnector();
  let best = null;
  let bestScore = -Infinity;
  for (const id of list) {
    const s = by[id] || {};
    const latency = s.p50Latency ?? 200;
    const success = s.successRate ?? 0.99;
    const sat = s.saturationPct ?? 0;

    if (typeof maxLatencyMs === 'number' && latency > maxLatencyMs) continue;
    if (typeof minSuccessRate === 'number' && success < minSuccessRate) continue;

    const score = (1 - Math.tanh(latency / 500)) * 0.5 + (success) * 0.4 + (1 - sat/100) * 0.1;
    if (score > bestScore) { bestScore = score; best = id; }
  }
  return best || list[0] || null;
}

module.exports = {
  recordAttempt,
  getRollingStats,
  getSaturation,
  pickBest
};
