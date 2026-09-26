// src/middleware/portalAuth.js
'use strict';
//
// Auth del PORTAL del merchant (M6). Plano separado del backoffice:
//
//   - Firma/verifica con PORTAL_JWT_SECRET (NO el BACKOFFICE_JWT_SECRET) y con
//     audience 'portal'. Un token de backoffice NO lleva aud 'portal' → aquí se
//     rechaza SIEMPRE. En sentido inverso, un token de portal solo es rechazado
//     por el backoffice si los dos secretos son distintos → por eso es REQUISITO
//     que PORTAL_JWT_SECRET != BACKOFFICE_JWT_SECRET en producción (documentado
//     en DEV-LOG). Es la separación criptográfica de los dos planos.
//
//   - Inyecta req.portalUser = { userId, merchantId, role, email, mustChangePassword }.
//     El merchantId sale SIEMPRE de aquí (la sesión), NUNCA del body/param/query.
//     Esa es la regla que impide el bug cross-tenant del DEV-LOG §4.
//
let jwt;
try { jwt = require('jsonwebtoken'); } catch { console.error('❌ jsonwebtoken no instalado.'); }
const { resolveSecret } = require('../utils/runtimeSecrets');

// FAIL-CLOSED (26 sep 2026): sin PORTAL_JWT_SECRET (fuera de development/test)
// el portal responde 503 en vez de firmar con el secreto público de desarrollo.
const SECRET    = resolveSecret('PORTAL_JWT_SECRET', 'dev_portal_secret_change_me');
const AUDIENCE  = 'portal';
const ALGORITHM = 'HS256';
const EXPIRES   = process.env.PORTAL_JWT_EXPIRES || '12h';

// Jerarquía de roles del plano merchant (independiente de la del backoffice).
const ROLE_RANK = { merchant_admin: 3, merchant_operator: 2, merchant_viewer: 1 };

function isConfigured() {
  return Boolean(jwt && SECRET);
}

function signPortalToken(payload, opts = {}) {
  if (!isConfigured()) throw new Error('portal_auth_not_configured');
  return jwt.sign(payload, SECRET, { algorithm: ALGORITHM, audience: AUDIENCE, expiresIn: EXPIRES, ...opts });
}

// Middleware base — valida el JWT del portal e inyecta req.portalUser
function portalAuth(req, res, next) {
  if (!jwt) return res.status(500).json({ success: false, error: 'jwt_unavailable' });
  if (!SECRET) return res.status(503).json({ success: false, error: 'portal_auth_not_configured' });
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, error: 'missing_token' });
  try {
    const decoded = jwt.verify(token, SECRET, { algorithms: [ALGORITHM], audience: AUDIENCE });
    req.portalUser = {
      userId:             decoded.userId,
      merchantId:         decoded.merchantId,
      role:               decoded.role,
      email:              decoded.email,
      mustChangePassword: !!decoded.mustChangePassword,
      // Fase 4 — nodo de jerarquía al que está restringido el usuario (o null =
      // ve todo su merchant). Gobierna el scoping por nodo en /portal/hierarchy.
      hierarchyNodeId:    decoded.hierarchyNodeId || null,
    };
    return next();
  } catch (err) {
    const msg = err.name === 'TokenExpiredError' ? 'token_expired' : 'invalid_token';
    return res.status(401).json({ success: false, error: msg });
  }
}

// requirePortalRole(minRole) — el usuario debe tener rango >= minRole
function requirePortalRole(minRole) {
  return function (req, res, next) {
    const userRank = ROLE_RANK[req.portalUser && req.portalUser.role] || 0;
    const minRank  = ROLE_RANK[minRole] || 0;
    if (userRank < minRank) {
      return res.status(403).json({
        success: false,
        error: 'insufficient_permissions',
        required: minRole,
        current: req.portalUser && req.portalUser.role,
      });
    }
    return next();
  };
}

// requirePasswordChanged — bloquea el portal mientras el usuario arrastre la
// password temporal (mustChangePassword). El único endpoint que NO debe montar
// esta guarda es /portal/auth/change-password (así es como se limpia el flag).
function requirePasswordChanged(req, res, next) {
  if (req.portalUser && req.portalUser.mustChangePassword) {
    return res.status(403).json({ success: false, error: 'password_change_required' });
  }
  return next();
}

module.exports = portalAuth;
module.exports.requirePortalRole      = requirePortalRole;
module.exports.requirePasswordChanged = requirePasswordChanged;
module.exports.signPortalToken        = signPortalToken;
module.exports.isConfigured           = isConfigured;
module.exports.ROLE_RANK              = ROLE_RANK;
module.exports.PORTAL_AUDIENCE        = AUDIENCE;
