'use strict';

/**
 * Logger mínimo con enmascarado de PII:
 * - PAN: 16/15/14 dígitos → 6 primeros + **** + 4 últimos
 * - CVV: reemplazado por "***"
 * - Tokens largos: muestra solo primeros 6 y últimos 4
 */
const LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();

function maskPAN(str) {
  return str.replace(/\b(\d{6})(\d{4,6})(\d{4})\b/g, '$1******$3');
}

function maskCVV(str) {
  return str.replace(/"cvv"\s*:\s*"?\d{3,4}"?/gi, '"cvv":"***"');
}

function maskTokens(str) {
  return str.replace(/"token"\s*:\s*"(.*?)"/gi, (m, p1) => {
    if (p1.length <= 12) return '"token":"***"';
    return `"token":"${p1.slice(0,6)}...${p1.slice(-4)}"`;
  });
}

function redact(obj) {
  try {
    const s = JSON.stringify(obj);
    const x = maskTokens(maskCVV(maskPAN(s)));
    return JSON.parse(x);
  } catch {
    return obj;
  }
}

function log(level, msg, obj) {
  if (!shouldLog(level)) return;
  const payload = obj ? ` ${JSON.stringify(redact(obj))}` : '';
  // eslint-disable-next-line no-console
  console.log(`[${level}] ${msg}${payload}`);
}

function shouldLog(lvl) {
  const order = ['trace','debug','info','warn','error','fatal'];
  return order.indexOf(lvl) >= order.indexOf(LEVEL);
}

module.exports = {
  trace: (m,o)=>log('trace', m,o),
  debug: (m,o)=>log('debug', m,o),
  info:  (m,o)=>log('info',  m,o),
  warn:  (m,o)=>log('warn',  m,o),
  error: (m,o)=>log('error', m,o),
  fatal: (m,o)=>log('fatal', m,o)
};
