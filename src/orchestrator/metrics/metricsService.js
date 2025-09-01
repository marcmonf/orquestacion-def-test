'use strict';

const WINDOW_MS = Number(process.env.METRICS_WINDOW_MS || 60_000);
const buckets = new Map();

function recordAttempt(connector, { ok, latencyMs, costBps }) {
  const now = Date.now();
  const arr = buckets.get(connector) || [];
  arr.push({ t: now, ok: !!ok, ms: Number(latencyMs) || 0, cost: Number(costBps) || 0 });
  const cutoff = now - WINDOW_MS;
  while (arr.length && arr[0].t < cutoff) arr.shift();
  buckets.set(connector, arr);
}

function snapshot(connector) {
  const arr = buckets.get(connector) || [];
  const n = arr.length || 1;
  const success = arr.filter(x => x.ok).length;
  const avgMs = arr.reduce((a, x) => a + x.ms, 0) / n;
  const avgCost = arr.reduce((a, x) => a + x.cost, 0) / n;
  return {
    count: arr.length,
    successRate: success / n,
    avgLatencyMs: avgMs,
    avgCostBps: avgCost
  };
}

function pickBest(candidates, { maxLatencyMs, minSuccessRate, maxCostBps } = {}) {
  const scored = candidates
    .map(id => ({ id, ...snapshot(id) }))
    .filter(s => (minSuccessRate == null || s.successRate >= minSuccessRate) &&
                 (maxLatencyMs == null || s.avgLatencyMs <= maxLatencyMs) &&
                 (maxCostBps == null || s.avgCostBps <= maxCostBps));
  if (!scored.length) return null;
  scored.sort((a, b) => (a.avgLatencyMs - b.avgLatencyMs) || (a.avgCostBps - b.avgCostBps));
  return scored[0].id;
}

module.exports = { recordAttempt, snapshot, pickBest };
