'use strict';

/**
 * Auth muy simple para backoffice.
 * Si ADMIN_TOKEN está definido, exige header:  X-Admin-Token: <token>
 * Si no está definido, pasa sin bloquear (dev).
 */
module.exports = function adminAuth(req, res, next) {
  const required = process.env.ADMIN_TOKEN;
  if (!required) return next(); // dev abierto

  const token = req.header('x-admin-token');
  if (!token || token !== required) {
    return res.status(401).json({ success: false, error: 'unauthorized' });
  }
  return next();
};
