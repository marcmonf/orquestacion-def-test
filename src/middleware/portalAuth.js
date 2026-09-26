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
//   - Inyecta req.portalUser = { userId, merchantId, role, email, mustChangePassword,
//     hierarchyNodeId }, leído del usuario en Mongo (ver revocación de sesiones).
//     El merchantId sale SIEMPRE de aquí (la sesión), NUNCA del body/param/query.
//     Esa es la regla que impide el bug cross-tenant del DEV-LOG §4.
//
let jwt;
try { jwt = require('jsonwebtoken'); } catch { console.error('❌ jsonwebtoken no instalado.'); }
const { resolveSecret } = require('../utils/runtimeSecrets');
const MerchantUser = require('../models/MerchantUser');

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

function verifyPortalToken(token) {
  return jwt.verify(token, SECRET, { algorithms: [ALGORITHM], audience: AUDIENCE });
}

// Usuario de la sesión, leído de Mongo en CADA petición (revocación de sesiones).
async function loadSessionUser(claims) {
  if (!claims || !claims.userId) return null;
  try {
    return await MerchantUser.findOne({ _id: claims.userId })
      .select('merchantId email role active mustChangePassword hierarchyNodeId tokenVersion')
      .lean();
  } catch (err) {
    if (err && err.name === 'CastError') return null;
    throw err;
  }
}

function sessionIsCurrent(user, claims) {
  return Boolean(user) && user.active !== false &&
    user.merchantId === claims.merchantId &&
    (Number(user.tokenVersion) || 0) === (Number(claims.tv) || 0);
}

// Middleware base — valida el JWT del portal e inyecta req.portalUser.
//
// REVOCACIÓN DE SESIONES (26 sep 2026): además de la firma, en cada petición el
// usuario tiene que existir, estar activo, ser del mismo merchant que el token y
// tener la misma versión de sesión (`tv` ↔ tokenVersion) → si no, 401
// `session_revoked`. Rol, cambio de password pendiente y nodo de jerarquía se
// toman de la BASE DE DATOS, no del token: desactivar a alguien, degradarlo o
// moverlo de nodo surte efecto en su siguiente petición (antes, hasta 12 h
// después). Si Mongo no responde → 503.
function portalAuth(req, res, next) {
  if (!jwt) return res.status(500).json({ success: false, error: 'jwt_unavailable' });
  if (!SECRET) return res.status(503).json({ success: false, error: 'portal_auth_not_configured' });
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, error: 'missing_token' });

  let claims;
  try {
    claims = verifyPortalToken(token);
  } catch (err) {
    const msg = err.name === 'TokenExpiredError' ? 'token_expired' : 'invalid_token';
    return res.status(401).json({ success: false, error: msg });
  }

  return loadSessionUser(claims).then((user) => {
    if (!sessionIsCurrent(user, claims)) {
      return res.status(401).json({ success: false, error: 'session_revoked' });
    }
    req.portalUser = {
      userId:             String(user._id),
      merchantId:         user.merchantId,
      role:               user.role,
      email:              user.email,
      mustChangePassword: !!user.mustChangePassword,
      // Fase 4 — nodo de jerarquía al que está restringido el usuario (o null =
      // ve todo su merchant). Gobierna el scoping por nodo en /portal/hierarchy
      // y en /portal/users.
      hierarchyNodeId:    user.hierarchyNodeId ? String(user.hierarchyNodeId) : null,
    };
    return next();
  }).catch((err) => {
    console.error('❌ [portalAuth] comprobación de sesión:', err && err.message);
    return res.status(503).json({ success: false, error: 'session_check_unavailable' });
  });
}

// Invalida TODAS las sesiones abiertas de un usuario del portal (sube tokenVersion).
async function revokeSessions(userId) {
  if (!userId) return;
  await MerchantUser.findOneAndUpdate({ _id: userId }, { $inc: { tokenVersion: 1 } });
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
module.exports.verifyPortalToken      = verifyPortalToken;
module.exports.revokeSessions         = revokeSessions;
module.exports.isConfigured           = isConfigured;
module.exports.ROLE_RANK              = ROLE_RANK;
module.exports.PORTAL_AUDIENCE        = AUDIENCE;
