// src/middleware/backofficeAuth.js
'use strict';

let jwt;
try { jwt = require('jsonwebtoken'); } catch {
  console.error('❌ jsonwebtoken no instalado. Añadir al package.json.');
}

const SECRET = process.env.BACKOFFICE_JWT_SECRET || 'dev_backoffice_secret_change_me';

/**
 * Middleware de sesión para el backoffice.
 * Espera el token en el header: Authorization: Bearer <token>
 * Inyecta req.backofficeUser = { merchantId, email, iat, exp }
 */
module.exports = function backofficeAuth(req, res, next) {
  if (!jwt) return res.status(500).json({ success: false, error: 'jwt_unavailable' });

  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ success: false, error: 'missing_token' });
  }

  try {
    const payload = jwt.verify(token, SECRET);
    req.backofficeUser = payload;
    return next();
  } catch (err) {
    const msg = err.name === 'TokenExpiredError' ? 'token_expired' : 'invalid_token';
    return res.status(401).json({ success: false, error: msg });
  }
};
