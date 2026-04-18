// src/middleware/backofficeAuth.js
'use strict';

let jwt;
try { jwt = require('jsonwebtoken'); } catch {
  console.error('❌ jsonwebtoken no instalado.');
}

const SECRET = process.env.BACKOFFICE_JWT_SECRET || 'dev_backoffice_secret_change_me';

// Jerarquía de roles
const ROLE_RANK = { superadmin: 4, admin: 3, operator: 2, viewer: 1 };

/**
 * Middleware base — valida JWT e inyecta req.backofficeUser
 */
function backofficeAuth(req, res, next) {
  if (!jwt) return res.status(500).json({ success: false, error: 'jwt_unavailable' });
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, error: 'missing_token' });
  try {
    req.backofficeUser = jwt.verify(token, SECRET);
    return next();
  } catch (err) {
    const msg = err.name === 'TokenExpiredError' ? 'token_expired' : 'invalid_token';
    return res.status(401).json({ success: false, error: msg });
  }
}

/**
 * requireRole(minRole) — el usuario debe tener rango >= minRole
 * Uso: router.post('/refund', backofficeAuth, requireRole('operator'), handler)
 */
function requireRole(minRole) {
  return function (req, res, next) {
    const userRank = ROLE_RANK[req.backofficeUser && req.backofficeUser.role] || 0;
    const minRank  = ROLE_RANK[minRole] || 0;
    if (userRank < minRank) {
      return res.status(403).json({
        success: false,
        error: 'insufficient_permissions',
        required: minRole,
        current: req.backofficeUser && req.backofficeUser.role
      });
    }
    return next();
  };
}

/**
 * requireMerchantAccess — verifica que el usuario tiene scope sobre el merchantId
 * del recurso que está consultando (inyectado como req.params.merchantId o req.backofficeUser.merchantId)
 */
function requireMerchantAccess(req, res, next) {
  const user = req.backofficeUser;
  if (!user) return res.status(401).json({ success: false, error: 'unauthorized' });

  // superadmin siempre pasa
  if (user.role === 'superadmin') return next();

  const scope = user.merchantScope || [];
  if (scope.includes('all')) return next();

  // El merchantId del recurso viene del JWT (sesión) o del param de la ruta
  const targetMerchant = req.params.merchantId || user.merchantId;
  if (!targetMerchant || !scope.includes(targetMerchant)) {
    return res.status(403).json({
      success: false,
      error: 'merchant_out_of_scope',
      scope
    });
  }
  return next();
}

module.exports = backofficeAuth;
module.exports.requireRole = requireRole;
module.exports.requireMerchantAccess = requireMerchantAccess;
module.exports.ROLE_RANK = ROLE_RANK;
