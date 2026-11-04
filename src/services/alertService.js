// src/services/alertService.js
'use strict';
//
// ALERTAS POR EMAIL (F2). Usa el mailer existente (SMTP de Workspace). Cada
// minuto (ALERT_INTERVAL_MS) se comprueba:
//   1. circuit_open:<conector>    — circuit breaker de un adquirente abierto.
//   2. webhooks_stuck             — hay webhooks salientes vencidos sin procesar
//                                   desde hace > ALERT_WEBHOOK_STUCK_MS (15 min)
//                                   o > ALERT_WEBHOOK_FAILED_HOUR (20) fallidos
//                                   definitivos en la última hora.
//   3. acquirer_errors:<conector> — más de ALERT_ACQUIRER_ERRORS_15M (10) errores
//                                   TÉCNICOS del adquirente en 15 min (no cuenta
//                                   rechazos del banco).
// Una alerta se envía al abrirse y otra al resolverse; mientras sigue activa,
// se recuerda como mucho cada ALERT_REPEAT_MS (1 h). Destinatarios:
// ALERT_EMAILS (separados por coma). Sin destinatarios o sin SMTP → solo log.
// El correo nunca lleva datos de comercios, pagos ni secretos.

const logger = require('../utils/logger');
const mailer = require('./mailer');
const environment = require('../utils/environment');
const health = require('./connectorHealth');
const statusService = require('./statusService');

const active = new Map(); // key → { since, lastSentAt, detail }

function num(k, d) { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? v : d; }

function recipients() {
  return String(process.env.ALERT_EMAILS || '').split(',').map((s) => s.trim()).filter((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s));
}

async function evaluate() {
  const found = new Map();
  const st = await statusService.snapshot({ fresh: true });
  for (const c of st.components.acquirers) {
    if (health.statusOf(c.id) === 'open') found.set(`circuit_open:${c.id}`, `El circuito del adquirente ${c.name} está ABIERTO: los checkouts nuevos se envían a otro adquirente si lo hay.`);
    if (c.recentErrors15m > num('ALERT_ACQUIRER_ERRORS_15M', 10)) found.set(`acquirer_errors:${c.id}`, `${c.recentErrors15m} errores técnicos de ${c.name} en los últimos 15 minutos.`);
  }
  const wh = st.components.webhooks;
  const internal = await statusService.webhooks();
  if (wh.state === 'delayed') found.set('webhooks_stuck', `Webhooks salientes atascados: el más antiguo lleva ${wh.oldestDueAgeSeconds} s vencido (${wh.pending} pendientes).`);
  else if ((internal.failedLastHour || 0) > num('ALERT_WEBHOOK_FAILED_HOUR', 20)) found.set('webhooks_stuck', `${internal.failedLastHour} webhooks salientes fallaron definitivamente en la última hora.`);
  return found;
}

async function send(subject, text) {
  const to = recipients();
  if (!to.length) {
    logger.warn('ALERT (sin ALERT_EMAILS)', { component: 'alerts', data: { subject } });
    return { sent: false, reason: 'no_recipients' };
  }
  try {
    return await mailer.sendMail({ to: to.join(', '), subject, text });
  } catch (err) {
    logger.error('ALERT_EMAIL_FAILED', { component: 'alerts', data: { subject, error: err.message } });
    return { sent: false, reason: 'send_failed' };
  }
}

async function tick(now = Date.now()) {
  const found = await evaluate();
  const env = environment.name();
  const sent = [];
  for (const [key, detail] of found) {
    const prev = active.get(key);
    if (!prev) {
      active.set(key, { since: now, lastSentAt: now, detail });
      await send(`[Monetiser ${env}] ALERTA: ${key}`, `${detail}\n\nEntorno: ${env}\nDesde: ${new Date(now).toISOString()}\nEstado: /status`);
      sent.push(`open:${key}`);
    } else if (now - prev.lastSentAt >= num('ALERT_REPEAT_MS', 3600 * 1000)) {
      prev.lastSentAt = now; prev.detail = detail;
      await send(`[Monetiser ${env}] SIGUE: ${key}`, `${detail}\n\nActiva desde: ${new Date(prev.since).toISOString()}`);
      sent.push(`repeat:${key}`);
    }
  }
  for (const [key, prev] of [...active]) {
    if (!found.has(key)) {
      active.delete(key);
      await send(`[Monetiser ${env}] RESUELTA: ${key}`, `Resuelta. Estuvo activa desde ${new Date(prev.since).toISOString()}.`);
      sent.push(`resolved:${key}`);
    }
  }
  return { active: [...active.keys()], sent };
}

let timer = null;
function start() {
  if (timer) return;
  timer = setInterval(() => { tick().catch((e) => logger.warn('ALERT_TICK_FAILED', { component: 'alerts', data: { error: e.message } })); }, num('ALERT_INTERVAL_MS', 60000));
  if (timer.unref) timer.unref();
}
function stop() { if (timer) clearInterval(timer); timer = null; }
function _reset() { active.clear(); }

module.exports = { tick, evaluate, start, stop, recipients, _reset };
