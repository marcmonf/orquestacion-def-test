'use strict';

/**
 * Auth de los pocos endpoints internos con token compartido (X-Admin-Token):
 * /orchestration/decide, GET /webhooks y la recuperación de cuentas de
 * backoffice (/backoffice/auth/setup y /reset-password). /rules, /merchants,
 * /api-keys y /diag se retiraron el 26 sep 2026 (viven en /admin con sesión).
 *
 * FAIL-CLOSED (26 sep 2026). Antes, si ADMIN_TOKEN no estaba definido, dejaba
 * pasar TODO ("dev abierto"): bastaba con que la variable faltase en un
 * despliegue para que la gestión de merchants, API keys y reglas quedase
 * pública. Ahora, sin ADMIN_TOKEN, estos endpoints responden 503 y no se abren.
 * La comparación del token es de tiempo constante.
 */
const crypto = require('crypto');

function safeEqual(a, b) {
  const A = crypto.createHash('sha256').update(String(a), 'utf8').digest();
  const B = crypto.createHash('sha256').update(String(b), 'utf8').digest();
  return crypto.timingSafeEqual(A, B);
}

module.exports = function adminAuth(req, res, next) {
  const required = process.env.ADMIN_TOKEN;
  if (!required) {
    return res.status(503).json({ success: false, error: 'admin_auth_not_configured' });
  }

  const token = req.header('x-admin-token');
  if (!token || !safeEqual(token, required)) {
    return res.status(401).json({ success: false, error: 'unauthorized' });
  }
  return next();
};

module.exports.safeEqual = safeEqual;
