// src/routes/portalAuthRoutes.js
'use strict';
//
// Auth PÚBLICA del portal del merchant (M6 Fase 1): login, cambio de password y
// logout. Plano separado del backoffice: modelo MerchantUser + JWT propio
// (PORTAL_JWT_SECRET, aud 'portal'). Ver src/middleware/portalAuth.js.
//
const express      = require('express');
const router       = express.Router();
const MerchantUser = require('../models/MerchantUser');
const portalAuth   = require('../middleware/portalAuth');
const rateLimiterPortalLogin = require('../middleware/rateLimiterPortalLogin');
const { signPortalToken } = portalAuth;

let bcrypt;
try { bcrypt = require('bcryptjs'); } catch {
  try { bcrypt = require('bcrypt'); } catch { console.error('❌ bcrypt/bcryptjs no instalado'); }
}

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket?.remoteAddress || null;
}

function tokenClaims(user) {
  return {
    userId:             user._id.toString(),
    merchantId:         user.merchantId,
    email:              user.email,
    role:               user.role,
    mustChangePassword: !!user.mustChangePassword,
  };
}

// ─────────────────────────────────────────────
// POST /portal/auth/login   (rate-limited)
// ─────────────────────────────────────────────
router.post('/login', rateLimiterPortalLogin, async (req, res) => {
  if (!bcrypt) return res.status(500).json({ success: false, error: 'dependencies_missing' });

  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ success: false, error: 'email_and_password_required' });
  }

  try {
    const user = await MerchantUser.findOne({ email: String(email).toLowerCase().trim(), active: true });
    if (!user || !user.passwordHash) {
      // Comparación dummy: no filtrar por tiempo si el email no existe.
      await bcrypt.compare('dummy', '$2b$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012345');
      return res.status(401).json({ success: false, error: 'invalid_credentials' });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.status(401).json({ success: false, error: 'invalid_credentials' });

    user.lastLoginAt = new Date();
    user.lastLoginIp = clientIp(req);
    await user.save();

    const token = signPortalToken(tokenClaims(user));

    return res.status(200).json({
      success: true,
      token,
      mustChangePassword: !!user.mustChangePassword,
      user: {
        email:      user.email,
        name:       user.name,
        role:       user.role,
        merchantId: user.merchantId,
      },
    });
  } catch (err) {
    console.error('❌ [portal/login]', err);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

// ─────────────────────────────────────────────
// POST /portal/auth/change-password
// Requiere sesión de portal. Permitido incluso bajo mustChangePassword: es
// justamente como se limpia el flag en el primer login. Devuelve un token fresco
// con el flag ya a false para que el portal deje de bloquear.
// ─────────────────────────────────────────────
router.post('/change-password', portalAuth, async (req, res) => {
  if (!bcrypt) return res.status(500).json({ success: false, error: 'dependencies_missing' });

  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ success: false, error: 'currentPassword_and_newPassword_required' });
  }
  if (String(newPassword).length < 8) {
    return res.status(400).json({ success: false, error: 'password_min_8_chars' });
  }
  if (newPassword === currentPassword) {
    return res.status(400).json({ success: false, error: 'new_password_must_differ' });
  }

  try {
    // El usuario solo puede cambiar SU propia password (id de la sesión).
    const user = await MerchantUser.findOne({ _id: req.portalUser.userId, active: true });
    if (!user) return res.status(404).json({ success: false, error: 'user_not_found' });

    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) return res.status(401).json({ success: false, error: 'invalid_credentials' });

    user.passwordHash       = await bcrypt.hash(newPassword, 10);
    user.mustChangePassword = false;
    await user.save();

    const token = signPortalToken(tokenClaims(user));
    return res.status(200).json({ success: true, message: 'password_updated', token });
  } catch (err) {
    console.error('❌ [portal/change-password]', err);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

// ─────────────────────────────────────────────
// POST /portal/auth/logout (stateless)
// ─────────────────────────────────────────────
router.post('/logout', (req, res) => res.status(200).json({ success: true, message: 'logged_out' }));

module.exports = router;
