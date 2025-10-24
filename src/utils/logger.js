// src/utils/logger.js
'use strict';

const { TraceLog, isEnabled } = require('../models/TraceLog');

const LEVELS = ['error', 'warning', 'info', 'debug', 'trace'];
const ENV_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const MIN_LEVEL_INDEX = Math.max(0, LEVELS.indexOf(ENV_LEVEL));

/**
 * Logger con soporte de contexto + envío a Mongo (tracelogs) sin bloquear.
 * - Llamadas no fallan si la BD de trazas no está disponible.
 * - Filtrado por nivel con LOG_LEVEL.
 * - API:
 *    logger.info(msg, ctx), logger.error(msg, ctx), logger.event(evt, msg, ctx), logger.child(ctxExtra)
 */
class Logger {
  constructor(baseCtx = {}) {
    this.baseCtx = baseCtx;
  }

  child(extra = {}) {
    return new Logger({ ...this.baseCtx, ...extra });
  }

  event(event, message, ctx = {}) {
    return this._write('info', message, { ...ctx, event });
  }

  error(message, ctx = {}) { return this._write('error', message, ctx); }
  warn(message, ctx = {})  { return this._write('warning', message, ctx); }
  info(message, ctx = {})  { return this._write('info', message, ctx); }
  debug(message, ctx = {}) { return this._write('debug', message, ctx); }
  trace(message, ctx = {}) { return this._write('trace', message, ctx); }

  _write(level, message, ctx = {}) {
    const idx = LEVELS.indexOf(level);
    if (idx > MIN_LEVEL_INDEX) return; // filtrado por nivel

    const payload = {
      level,
      message,
      component: ctx.component || this.baseCtx.component || 'app',
      event: ctx.event,
      traceId: ctx.traceId || this.baseCtx.traceId,
      requestId: ctx.requestId || this.baseCtx.requestId,
      sessionId: ctx.sessionId || this.baseCtx.sessionId,
      paymentId: ctx.paymentId || this.baseCtx.paymentId,
      merchantId: ctx.merchantId || this.baseCtx.merchantId,
      spanId: ctx.spanId || this.baseCtx.spanId,
      parentSpanId: ctx.parentSpanId || this.baseCtx.parentSpanId,
      ip: ctx.ip || this.baseCtx.ip,
      userAgent: ctx.userAgent || this.baseCtx.userAgent,
      data: sanitizeData(ctx.data),
    };

    // Consola (no sensible)
    // eslint-disable-next-line no-console
    console.log(formatConsole(level, message, payload));

    // Mongo (best-effort, no await)
    if (isEnabled && TraceLog) {
      TraceLog.create(payload).catch(err => {
        // eslint-disable-next-line no-console
        console.warn('⚠️ [TRACELOG] fallo grabando traza:', err.message);
      });
    }
  }
}

function formatConsole(level, message, p) {
  const k = [
    p.component && `[${p.component}]`,
    p.event && p.event,
    p.paymentId && `pid=${p.paymentId}`,
    p.merchantId && `mid=${p.merchantId}`,
    p.requestId && `rid=${p.requestId}`,
  ].filter(Boolean).join(' ');
  return `${new Date().toISOString()} ${level.toUpperCase()} ${k} :: ${message}${p.data ? ` :: ${safeStringify(p.data)}` : ''}`;
}

function safeStringify(obj) {
  try { return JSON.stringify(obj); } catch { return '[unserializable]'; }
}

// IMPORTANTÍSIMO: nunca metas PAN, CVC, PII cruda en data
function sanitizeData(data) {
  if (!data || typeof data !== 'object') return data;
  const clone = JSON.parse(JSON.stringify(data));
  const scrub = (o) => {
    for (const k of Object.keys(o)) {
      const key = k.toLowerCase();
      if (/(cardnumber|pan|cvc|cvv|expiry|expirymonth|expiryyear|ssn|dni|passport|email|phone)/.test(key)) {
        o[k] = '[REDACTED]';
      } else if (o[k] && typeof o[k] === 'object') {
        scrub(o[k]);
      }
    }
  };
  scrub(clone);
  return clone;
}

// Singleton por defecto
const logger = new Logger({ component: 'app' });
module.exports = logger;
module.exports.Logger = Logger;
