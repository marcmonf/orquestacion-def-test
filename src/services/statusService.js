// src/services/statusService.js
'use strict';
//
// ESTADO DEL SISTEMA (F2): lo usan /health/ready, la página pública /status y
// las alertas. Solo información agregada: NUNCA datos de comercios, pagos,
// URLs de webhooks ni secretos.

const mongoose = require('mongoose');
const environment = require('../utils/environment');
const health = require('./connectorHealth');
const registry = require('./connectorRegistry');
const dispatcher = require('./webhookDispatcher');
const { canQuery } = require('../utils/dbReady');
const WebhookLog = require('../models/WebhookLog');

const STUCK_MS = () => Number(process.env.ALERT_WEBHOOK_STUCK_MS) || 15 * 60 * 1000;

let pingImpl = null; // solo tests
async function dbPing() {
  if (pingImpl) return pingImpl();
  if (mongoose.connection.readyState !== 1) return { ok: false, state: 'disconnected' };
  try {
    await Promise.race([
      mongoose.connection.db.admin().ping(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2000)),
    ]);
    return { ok: true, state: 'up' };
  } catch (e) {
    return { ok: false, state: 'error' };
  }
}

async function webhooks() {
  if (!canQuery(WebhookLog)) return { ok: false, state: 'unknown', worker: dispatcher.workerState() };
  try {
    const q = await dispatcher.queueStats();
    const stuck = q.oldestDueAgeMs > STUCK_MS();
    return { ok: !stuck, state: stuck ? 'delayed' : 'operational', pending: q.pending, oldestDueAgeSeconds: Math.round(q.oldestDueAgeMs / 1000), failedLastHour: q.failedLastHour, worker: dispatcher.workerState() };
  } catch (_) {
    return { ok: false, state: 'unknown', worker: dispatcher.workerState() };
  }
}

function connectors() {
  return registry.listProviders()
    .filter((p) => !p.capabilities.simulated && !p.capabilities.testOnly)
    .map((p) => {
      const st = health.statusOf(p.id);
      return { id: p.id, name: p.displayName, state: st === 'closed' ? 'operational' : st === 'half_open' ? 'recovering' : 'degraded', recentErrors15m: health.recentTechnicalErrors(p.id) };
    });
}

let cache = null;
async function snapshot({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < 30000) return cache.data;
  const [db, wh] = await Promise.all([dbPing(), webhooks()]);
  const conns = connectors();
  const overall = !db.ok ? 'major_outage'
    : (conns.some((c) => c.state !== 'operational') || !wh.ok) ? 'degraded' : 'operational';
  const data = {
    environment: environment.name(),
    status: overall,
    checkedAt: new Date().toISOString(),
    components: {
      api: { state: 'operational' },
      database: { state: db.ok ? 'operational' : 'major_outage' },
      webhooks: { state: wh.state, pending: wh.pending ?? null, oldestDueAgeSeconds: wh.oldestDueAgeSeconds ?? null },
      acquirers: conns,
    },
  };
  cache = { at: Date.now(), data, internal: { db, wh } };
  return data;
}

// Readiness: ¿este proceso puede servir pagos AHORA? (no cacheado)
async function readiness() {
  const db = await dbPing();
  const worker = dispatcher.workerState();
  const issues = [];
  if (!db.ok) issues.push('database');
  if (!worker.running) issues.push('webhook_worker');
  for (const m of environment.mismatches()) issues.push('environment_mismatch');
  return { ready: issues.length === 0, environment: environment.name(), issues: [...new Set(issues)] };
}

function _clearCache() { cache = null; }
function _setDbPing(fn) { pingImpl = fn; }

module.exports = { snapshot, readiness, connectors, webhooks, dbPing, _clearCache, _setDbPing };
