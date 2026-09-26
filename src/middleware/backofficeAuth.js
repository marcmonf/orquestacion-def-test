// src/middleware/backofficeAuth.js
'use strict';

let jwt;
try { jwt = require('jsonwebtoken'); } catch {
  console.error('❌ jsonwebtoken no instalado.');
}
const { resolveSecret } = require('../utils/runtimeSecrets');
const BackofficeUser = require('../models/BackofficeUser');

// FAIL-CLOSED: sin BACKOFFICE_JWT_SECRET (fuera de development/test) el
// backoffice responde 503 en vez de firmar con un secreto público. Ver
// src/utils/runtimeSecrets.js.
const SECRET    = resolveSecret('BACKOFFICE_JWT_SECRET', 'dev_backoffice_secret_change_me');
const AUDIENCE  = 'backoffice';
const ALGORITHM = 'HS256';
const EXPIRES   = process.env.BACKOFFICE_JWT_EXPIRES || '12h';

// Jerarquía de roles
const ROLE_RANK = { superadmin: 4, admin: 3, operator: 2, viewer: 1 };

function isConfigured() {
  return Boolean(jwt && SECRET);
}

/**
 * Firma un token de sesión de backoffice. Lleva audience 'backoffice' para que
 * un token de otro plano (portal) nunca se acepte aquí aunque, por error de
 * configuración, los dos secretos coincidieran.
 */
function signBackofficeToken(payload) {
  if (!isConfigured()) throw new Error('backoffice_auth_not_configured');
  return jwt.sign(payload, SECRET, { algorithm: ALGORITHM, audience: AUDIENCE, expiresIn: EXPIRES });
}

// Verifica firma, audience y caducidad. Devuelve los claims o lanza.
function verifyBackofficeToken(token) {
  return jwt.verify(token, SECRET, { algorithms: [ALGORITHM], audience: AUDIENCE });
}

// Usuario de la sesión, leído de Mongo en CADA petición (revocación de sesiones).
// Un userId que no es un ObjectId (token falso o de otra época) = sin usuario.
async function loadSessionUser(claims) {
  if (!claims || !claims.userId) return null;
  try {
    return await BackofficeUser.findOne({ _id: claims.userId })
      .select('email name role merchantScope active tokenVersion')
      .lean();
  } catch (err) {
    if (err && err.name === 'CastError') return null;
    throw err;
  }
}

function sessionIsCurrent(user, claims) {
  return Boolean(user) && user.active !== false &&
    (Number(user.tokenVersion) || 0) === (Number(claims.tv) || 0);
}

/**
 * Middleware base — valida el JWT e inyecta req.backofficeUser.
 *
 * REVOCACIÓN DE SESIONES (26 sep 2026). Antes bastaba con la firma: un usuario
 * desactivado, degradado o con la contraseña reseteada seguía entrando con su
 * token hasta que caducaba (12 h). Ahora, en cada petición:
 *   - el usuario tiene que existir y estar activo;
 *   - la versión del token (`tv`) tiene que coincidir con la del usuario
 *     (`tokenVersion`, que se sube al desactivar, cambiar rol/alcance, resetear
 *     la contraseña o cerrar sesión) → si no, 401 `session_revoked`;
 *   - rol y alcance se toman de la BASE DE DATOS, no del token: un cambio de
 *     permisos se aplica en la siguiente petición.
 * Si Mongo no responde → 503 (nunca se deja pasar sin comprobar).
 */
function backofficeAuth(req, res, next) {
  if (!jwt) return res.status(500).json({ success: false, error: 'jwt_unavailable' });
  if (!SECRET) return res.status(503).json({ success: false, error: 'backoffice_auth_not_configured' });
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, error: 'missing_token' });

  let claims;
  try {
    claims = verifyBackofficeToken(token);
  } catch (err) {
    const msg = err.name === 'TokenExpiredError' ? 'token_expired' : 'invalid_token';
    return res.status(401).json({ success: false, error: msg });
  }

  return loadSessionUser(claims).then((user) => {
    if (!sessionIsCurrent(user, claims)) {
      return res.status(401).json({ success: false, error: 'session_revoked' });
    }
    req.backofficeUser = {
      userId:        String(user._id),
      email:         user.email,
      name:          user.name,
      role:          user.role,
      merchantScope: Array.isArray(user.merchantScope) ? user.merchantScope : [],
    };
    return next();
  }).catch((err) => {
    console.error('❌ [backofficeAuth] comprobación de sesión:', err && err.message);
    return res.status(503).json({ success: false, error: 'session_check_unavailable' });
  });
}

/**
 * Invalida TODAS las sesiones abiertas de un usuario (sube tokenVersion).
 * Se llama al desactivar, cambiar rol/alcance, resetear la contraseña o cerrar
 * sesión.
 */
async function revokeSessions(userId) {
  if (!userId) return;
  await BackofficeUser.findOneAndUpdate({ _id: userId }, { $inc: { tokenVersion: 1 } });
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
module.exports.signBackofficeToken = signBackofficeToken;
module.exports.verifyBackofficeToken = verifyBackofficeToken;
module.exports.revokeSessions = revokeSessions;
module.exports.isConfigured = isConfigured;
module.exports.ROLE_RANK = ROLE_RANK;
module.exports.BACKOFFICE_AUDIENCE = AUDIENCE;
