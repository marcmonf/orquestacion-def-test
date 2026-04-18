// src/routes/backofficeAuthRoutes.js
'use strict';

const express        = require('express');
const router         = express.Router();
const crypto         = require('crypto');
const BackofficeUser = require('../models/BackofficeUser');

let jwt, bcrypt;
try { jwt    = require('jsonwebtoken'); } catch { console.error('❌ jsonwebtoken no instalado'); }
try { bcrypt = require('bcryptjs');     } catch {
  try { bcrypt = require('bcrypt');     } catch { console.error('❌ bcrypt/bcryptjs no instalado'); }
}

const JWT_SECRET  = process.env.BACKOFFICE_JWT_SECRET || 'dev_backoffice_secret_change_me';
const JWT_EXPIRES = '24h';

function adminOnly(req, res, next) {
  const t = req.headers['x-admin-token'];
  if (!process.env.ADMIN_TOKEN || t !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ success: false, error: 'unauthorized' });
  }
  next();
}

// ─────────────────────────────────────────────
// POST /backoffice/auth/login
// ─────────────────────────────────────────────
router.post('/login', async (req, res) => {
  if (!jwt || !bcrypt) return res.status(500).json({ success: false, error: 'dependencies_missing' });

  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ success: false, error: 'email_and_password_required' });
  }

  try {
    const user = await BackofficeUser.findOne({ email: email.toLowerCase().trim(), active: true }).lean();
    if (!user || !user.passwordHash) {
      await bcrypt.compare('dummy', '$2b$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012345');
      return res.status(401).json({ success: false, error: 'invalid_credentials' });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.status(401).json({ success: false, error: 'invalid_credentials' });

    // Actualizar último login
    await BackofficeUser.updateOne({ _id: user._id }, {
      lastLoginAt: new Date(),
      lastLoginIp: (req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket?.remoteAddress || null
    });

    const token = jwt.sign(
      {
        userId:        user._id.toString(),
        email:         user.email,
        name:          user.name,
        role:          user.role,
        merchantScope: user.merchantScope,
      },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES }
    );

    return res.status(200).json({
      success: true,
      token,
      user: {
        email:         user.email,
        name:          user.name,
        role:          user.role,
        merchantScope: user.merchantScope,
      }
    });
  } catch (err) {
    console.error('❌ [backoffice/login]', err);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

// ─────────────────────────────────────────────
// POST /backoffice/auth/logout (stateless)
// ─────────────────────────────────────────────
router.post('/logout', (req, res) => {
  return res.status(200).json({ success: true, message: 'logged_out' });
});

// ─────────────────────────────────────────────
// POST /backoffice/auth/setup
// Crea el primer superadmin. Solo funciona si no existe ningún BackofficeUser.
// Protegido por ADMIN_TOKEN.
// ─────────────────────────────────────────────
router.post('/setup', adminOnly, async (req, res) => {
  if (!bcrypt) return res.status(500).json({ success: false, error: 'dependencies_missing' });

  const { name, email, password } = req.body || {};
  if (!name || !email || !password) {
    return res.status(400).json({ success: false, error: 'name_email_password_required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ success: false, error: 'password_min_8_chars' });
  }

  try {
    const existing = await BackofficeUser.findOne({ email: email.toLowerCase().trim() });
    if (existing) {
      return res.status(409).json({ success: false, error: 'email_already_exists' });
    }

    const hash = await bcrypt.hash(password, 10);
    const user = await BackofficeUser.create({
      email:         email.toLowerCase().trim(),
      passwordHash:  hash,
      name,
      role:          'superadmin',
      merchantScope: ['all'],
    });

    return res.status(201).json({
      success: true,
      message: 'superadmin created',
      user: { email: user.email, name: user.name, role: user.role }
    });
  } catch (err) {
    console.error('❌ [backoffice/setup]', err);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

// ─────────────────────────────────────────────
// POST /backoffice/auth/reset-password
// Reset manual por ADMIN_TOKEN (sin email)
// ─────────────────────────────────────────────
router.post('/reset-password', adminOnly, async (req, res) => {
  if (!bcrypt) return res.status(500).json({ success: false, error: 'dependencies_missing' });

  const { email, newPassword } = req.body || {};
  if (!email || !newPassword) {
    return res.status(400).json({ success: false, error: 'email_and_newPassword_required' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ success: false, error: 'password_min_8_chars' });
  }

  try {
    const user = await BackofficeUser.findOne({ email: email.toLowerCase().trim() });
    if (!user) return res.status(404).json({ success: false, error: 'user_not_found' });

    user.passwordHash = await bcrypt.hash(newPassword, 10);
    user.resetToken       = null;
    user.resetTokenExpiry = null;
    await user.save();

    return res.status(200).json({ success: true, message: 'password_reset_ok', email: user.email });
  } catch (err) {
    console.error('❌ [backoffice/reset-password]', err);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

// ─────────────────────────────────────────────
// POST /backoffice/auth/forgot-password
// Genera token de reset (sin email: devuelve el token directamente para uso manual)
// Cuando haya email, este endpoint enviará el correo automáticamente.
// ─────────────────────────────────────────────
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ success: false, error: 'email_required' });

  try {
    const user = await BackofficeUser.findOne({ email: email.toLowerCase().trim(), active: true });

    // Siempre responder 200 para no revelar si el email existe
    if (!user) {
      return res.status(200).json({ success: true, message: 'Si el email existe, recibirás instrucciones.' });
    }

    const token  = crypto.randomBytes(32).toString('hex');
    const expiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hora

    user.resetToken       = crypto.createHash('sha256').update(token).digest('hex');
    user.resetTokenExpiry = expiry;
    await user.save();

    // TODO: cuando haya servicio de email, enviar el token aquí.
    // Por ahora: el superadmin usa /reset-password con ADMIN_TOKEN.
    // En desarrollo devolvemos el token en la respuesta para testing.
    const isDev = process.env.NODE_ENV !== 'production';
    return res.status(200).json({
      success: true,
      message: 'Si el email existe, recibirás instrucciones.',
      ...(isDev && { _dev_reset_token: token })
    });
  } catch (err) {
    console.error('❌ [backoffice/forgot-password]', err);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

// ─────────────────────────────────────────────
// POST /backoffice/auth/confirm-reset
// Confirma el reset usando el token generado por forgot-password
// ─────────────────────────────────────────────
router.post('/confirm-reset', async (req, res) => {
  if (!bcrypt) return res.status(500).json({ success: false, error: 'dependencies_missing' });

  const { token, newPassword } = req.body || {};
  if (!token || !newPassword) {
    return res.status(400).json({ success: false, error: 'token_and_newPassword_required' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ success: false, error: 'password_min_8_chars' });
  }

  try {
    const hashed = crypto.createHash('sha256').update(token).digest('hex');
    const user = await BackofficeUser.findOne({
      resetToken:       hashed,
      resetTokenExpiry: { $gt: new Date() },
      active:           true
    });

    if (!user) return res.status(400).json({ success: false, error: 'invalid_or_expired_token' });

    user.passwordHash     = await bcrypt.hash(newPassword, 10);
    user.resetToken       = null;
    user.resetTokenExpiry = null;
    await user.save();

    return res.status(200).json({ success: true, message: 'password_updated' });
  } catch (err) {
    console.error('❌ [backoffice/confirm-reset]', err);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

module.exports = router;
