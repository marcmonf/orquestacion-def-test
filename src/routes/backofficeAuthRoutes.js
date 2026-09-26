// src/routes/backofficeAuthRoutes.js
'use strict';

const express        = require('express');
const router         = express.Router();
const crypto         = require('crypto');
const BackofficeUser = require('../models/BackofficeUser');
const adminAuth      = require('../middleware/adminAuth');
const {
  signBackofficeToken, verifyBackofficeToken, revokeSessions, isConfigured,
} = require('../middleware/backofficeAuth');
const { makeLoginLimiters } = require('../middleware/rateLimiterLogin');

let bcrypt;
try { bcrypt = require('bcryptjs'); } catch {
  try { bcrypt = require('bcrypt'); } catch { console.error('❌ bcrypt/bcryptjs no instalado'); }
}

const BCRYPT_COST = 12;

// Hash real (no una cadena malformada) para igualar tiempos cuando el email no
// existe. Con el literal anterior, bcrypt respondía al instante y el tiempo de
// respuesta revelaba qué emails tienen cuenta.
const DUMMY_HASH = bcrypt ? bcrypt.hashSync('monetiser-timing-equalizer', 10) : null;

// Login + recuperación: límite por IP+email y por email (ataque distribuido).
const loginLimiters = makeLoginLimiters({
  name:          'backoffice',
  windowMs:      parseInt(process.env.RL_BACKOFFICE_LOGIN_WINDOW_MS || '900000', 10), // 15 min
  maxPerIpEmail: parseInt(process.env.RL_BACKOFFICE_LOGIN_MAX || '10', 10),
  maxPerEmail:   parseInt(process.env.RL_BACKOFFICE_LOGIN_MAX_PER_EMAIL || '30', 10),
});

function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || null;
}

// ─────────────────────────────────────────────
// POST /backoffice/auth/login
// ─────────────────────────────────────────────
router.post('/login', loginLimiters, async (req, res) => {
  if (!bcrypt) return res.status(500).json({ success: false, error: 'dependencies_missing' });
  if (!isConfigured()) return res.status(503).json({ success: false, error: 'backoffice_auth_not_configured' });

  const { email, password } = req.body || {};
  if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ success: false, error: 'email_and_password_required' });
  }

  try {
    const user = await BackofficeUser.findOne({ email: email.toLowerCase().trim(), active: true }).lean();
    if (!user || !user.passwordHash) {
      await bcrypt.compare(password, DUMMY_HASH);
      return res.status(401).json({ success: false, error: 'invalid_credentials' });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.status(401).json({ success: false, error: 'invalid_credentials' });

    // Actualizar último login
    await BackofficeUser.updateOne({ _id: user._id }, {
      lastLoginAt: new Date(),
      lastLoginIp: clientIp(req)
    });

    const token = signBackofficeToken({
      userId:        user._id.toString(),
      email:         user.email,
      name:          user.name,
      role:          user.role,
      merchantScope: user.merchantScope,
      tv:            Number(user.tokenVersion) || 0,   // versión de sesión (ver backofficeAuth)
    });

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
// POST /backoffice/auth/logout
// Cierra la sesión DE VERDAD: invalida todos los tokens del usuario (antes era
// "stateless": el token seguía valiendo 12 h aunque se pulsase Salir). Responde
// 200 siempre, con token válido o sin él.
// ─────────────────────────────────────────────
router.post('/logout', async (req, res) => {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (token && isConfigured()) {
    try {
      const claims = verifyBackofficeToken(token);
      await revokeSessions(claims.userId);
    } catch { /* token caducado o inválido: no hay nada que cerrar */ }
  }
  return res.status(200).json({ success: true, message: 'logged_out' });
});

// ─────────────────────────────────────────────
// POST /backoffice/auth/setup
// Crea el PRIMER superadmin (arranque de una instalación nueva). Protegido por
// ADMIN_TOKEN y de UN SOLO USO: si ya existe algún usuario de backoffice →
// 409. El comentario original ya decía "solo si no existe ningún
// BackofficeUser", pero el código solo rechazaba el email repetido: con el
// ADMIN_TOKEN se podían crear superadmins sin límite. Los siguientes usuarios se
// crean desde /admin → Usuarios (sesión de superadmin); la recuperación de una
// cuenta, con /reset-password + ADMIN_TOKEN.
// ─────────────────────────────────────────────
router.post('/setup', adminAuth, async (req, res) => {
  if (!bcrypt) return res.status(500).json({ success: false, error: 'dependencies_missing' });

  const { name, email, password } = req.body || {};
  if (!name || !email || !password || typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ success: false, error: 'name_email_password_required' });
  }
  if (password.length < 12) {
    return res.status(400).json({ success: false, error: 'password_min_12_chars' });
  }

  try {
    const anyUser = await BackofficeUser.countDocuments({});
    if (anyUser > 0) {
      return res.status(409).json({ success: false, error: 'setup_already_done' });
    }

    const hash = await bcrypt.hash(password, BCRYPT_COST);
    const user = await BackofficeUser.create({
      email:         email.toLowerCase().trim(),
      passwordHash:  hash,
      name:          String(name),
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
router.post('/reset-password', adminAuth, async (req, res) => {
  if (!bcrypt) return res.status(500).json({ success: false, error: 'dependencies_missing' });

  const { email, newPassword } = req.body || {};
  if (!email || !newPassword || typeof email !== 'string' || typeof newPassword !== 'string') {
    return res.status(400).json({ success: false, error: 'email_and_newPassword_required' });
  }
  if (newPassword.length < 12) {
    return res.status(400).json({ success: false, error: 'password_min_12_chars' });
  }

  try {
    const user = await BackofficeUser.findOne({ email: email.toLowerCase().trim() });
    if (!user) return res.status(404).json({ success: false, error: 'user_not_found' });

    user.passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);
    user.resetToken       = null;
    user.resetTokenExpiry = null;
    // Reset = posible cuenta comprometida: se cierran todas sus sesiones.
    user.tokenVersion     = (Number(user.tokenVersion) || 0) + 1;
    await user.save();

    return res.status(200).json({ success: true, message: 'password_reset_ok', email: user.email });
  } catch (err) {
    console.error('❌ [backoffice/reset-password]', err);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

// ─────────────────────────────────────────────
// POST /backoffice/auth/forgot-password
// Genera token de reset. Hasta que haya envío de email, el token NO se devuelve
// nunca en la respuesta: el superadmin resetea con /reset-password + ADMIN_TOKEN.
//
// ANTES devolvía el token en `_dev_reset_token` siempre que NODE_ENV no fuese
// 'production' — y en Render NODE_ENV no está definido. Es decir: sabiendo solo
// el email de un superadmin, cualquiera obtenía el token, llamaba a
// /confirm-reset y se quedaba con la cuenta. Cerrado el 26 sep 2026. Solo se
// devuelve con la variable explícita BACKOFFICE_DEV_RESET_TOKEN=true en un
// entorno development/test.
// ─────────────────────────────────────────────
router.post('/forgot-password', loginLimiters, async (req, res) => {
  const { email } = req.body || {};
  if (!email || typeof email !== 'string') return res.status(400).json({ success: false, error: 'email_required' });

  const generic = { success: true, message: 'Si el email existe, recibirás instrucciones.' };

  try {
    const user = await BackofficeUser.findOne({ email: email.toLowerCase().trim(), active: true });

    // Siempre responder 200 para no revelar si el email existe
    if (!user) return res.status(200).json(generic);

    const token  = crypto.randomBytes(32).toString('hex');
    const expiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hora

    user.resetToken       = crypto.createHash('sha256').update(token).digest('hex');
    user.resetTokenExpiry = expiry;
    await user.save();

    // TODO: cuando haya servicio de email, enviar el token aquí.
    const exposeForDev =
      ['development', 'test'].includes(String(process.env.NODE_ENV || '').toLowerCase()) &&
      String(process.env.BACKOFFICE_DEV_RESET_TOKEN || '').toLowerCase() === 'true';

    return res.status(200).json({ ...generic, ...(exposeForDev && { _dev_reset_token: token }) });
  } catch (err) {
    console.error('❌ [backoffice/forgot-password]', err);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

// ─────────────────────────────────────────────
// POST /backoffice/auth/confirm-reset
// Confirma el reset usando el token generado por forgot-password
// ─────────────────────────────────────────────
router.post('/confirm-reset', loginLimiters, async (req, res) => {
  if (!bcrypt) return res.status(500).json({ success: false, error: 'dependencies_missing' });

  const { token, newPassword } = req.body || {};
  if (!token || !newPassword || typeof token !== 'string' || typeof newPassword !== 'string') {
    return res.status(400).json({ success: false, error: 'token_and_newPassword_required' });
  }
  if (newPassword.length < 12) {
    return res.status(400).json({ success: false, error: 'password_min_12_chars' });
  }

  try {
    const hashed = crypto.createHash('sha256').update(token).digest('hex');
    const user = await BackofficeUser.findOne({
      resetToken:       hashed,
      resetTokenExpiry: { $gt: new Date() },
      active:           true
    });

    if (!user) return res.status(400).json({ success: false, error: 'invalid_or_expired_token' });

    user.passwordHash     = await bcrypt.hash(newPassword, BCRYPT_COST);
    user.resetToken       = null;
    user.resetTokenExpiry = null;
    user.tokenVersion     = (Number(user.tokenVersion) || 0) + 1;   // cierra sus sesiones
    await user.save();

    return res.status(200).json({ success: true, message: 'password_updated' });
  } catch (err) {
    console.error('❌ [backoffice/confirm-reset]', err);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

module.exports = router;
