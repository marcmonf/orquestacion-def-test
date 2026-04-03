// src/routes/backofficeAuthRoutes.js
'use strict';

const express  = require('express');
const router   = express.Router();
const Merchant = require('../models/Merchant');

let jwt, bcrypt;
try { jwt    = require('jsonwebtoken'); } catch { console.error('❌ jsonwebtoken no instalado'); }
try { bcrypt = require('bcryptjs');     } catch {
  try { bcrypt = require('bcrypt');     } catch { console.error('❌ bcrypt/bcryptjs no instalado'); }
}

const JWT_SECRET  = process.env.BACKOFFICE_JWT_SECRET || 'dev_backoffice_secret_change_me';
const JWT_EXPIRES = '24h';

// ─────────────────────────────────────────────
// POST /backoffice/auth/login
// Body: { email, password }
// ─────────────────────────────────────────────
router.post('/login', async (req, res) => {
  if (!jwt || !bcrypt) {
    return res.status(500).json({ success: false, error: 'dependencies_missing' });
  }

  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ success: false, error: 'email_and_password_required' });
  }

  try {
    const merchant = await Merchant.findOne({ email: email.toLowerCase().trim() }).lean();
    if (!merchant || !merchant.passwordHash) {
      // Tiempo constante para evitar timing attacks
      await bcrypt.compare('dummy', '$2b$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012345');
      return res.status(401).json({ success: false, error: 'invalid_credentials' });
    }

    const valid = await bcrypt.compare(password, merchant.passwordHash);
    if (!valid) {
      return res.status(401).json({ success: false, error: 'invalid_credentials' });
    }

    const token = jwt.sign(
      {
        merchantId:   merchant.merchantId,
        merchantName: merchant.merchantName || merchant.merchantId,
        email:        merchant.email,
      },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES }
    );

    return res.status(200).json({
      success: true,
      token,
      merchant: {
        merchantId:   merchant.merchantId,
        merchantName: merchant.merchantName || merchant.merchantId,
        email:        merchant.email,
      }
    });
  } catch (err) {
    console.error('❌ [backoffice/login]', err);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

// ─────────────────────────────────────────────
// POST /backoffice/auth/logout
// Stateless: el cliente descarta el token.
// ─────────────────────────────────────────────
router.post('/logout', (req, res) => {
  return res.status(200).json({ success: true, message: 'logged_out' });
});

// ─────────────────────────────────────────────
// POST /backoffice/auth/setup
// Solo funciona si el merchant NO tiene passwordHash todavía.
// Protegido por ADMIN_TOKEN para que nadie externo lo use.
// ─────────────────────────────────────────────
router.post('/setup', async (req, res) => {
  if (!bcrypt) return res.status(500).json({ success: false, error: 'dependencies_missing' });

  const adminToken = req.headers['x-admin-token'];
  if (!process.env.ADMIN_TOKEN || adminToken !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ success: false, error: 'unauthorized' });
  }

  const { merchantId, email, password } = req.body || {};
  if (!merchantId || !email || !password) {
    return res.status(400).json({ success: false, error: 'merchantId_email_password_required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ success: false, error: 'password_min_8_chars' });
  }

  try {
    const merchant = await Merchant.findOne({ merchantId });
    if (!merchant) {
      return res.status(404).json({ success: false, error: 'merchant_not_found' });
    }
    if (merchant.passwordHash) {
      return res.status(409).json({ success: false, error: 'credentials_already_set — use /reset' });
    }

    const hash = await bcrypt.hash(password, 10);
    merchant.email        = email.toLowerCase().trim();
    merchant.passwordHash = hash;
    await merchant.save();

    return res.status(201).json({
      success: true,
      message: 'backoffice credentials set',
      merchantId: merchant.merchantId,
      email: merchant.email
    });
  } catch (err) {
    console.error('❌ [backoffice/setup]', err);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

// ─────────────────────────────────────────────
// POST /backoffice/auth/reset-password
// Cambia la contraseña de un merchant existente.
// Protegido por ADMIN_TOKEN.
// ─────────────────────────────────────────────
router.post('/reset-password', async (req, res) => {
  if (!bcrypt) return res.status(500).json({ success: false, error: 'dependencies_missing' });

  const adminToken = req.headers['x-admin-token'];
  if (!process.env.ADMIN_TOKEN || adminToken !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ success: false, error: 'unauthorized' });
  }

  const { merchantId, newPassword } = req.body || {};
  if (!merchantId || !newPassword) {
    return res.status(400).json({ success: false, error: 'merchantId_and_newPassword_required' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ success: false, error: 'password_min_8_chars' });
  }

  try {
    const merchant = await Merchant.findOne({ merchantId });
    if (!merchant) return res.status(404).json({ success: false, error: 'merchant_not_found' });

    merchant.passwordHash = await bcrypt.hash(newPassword, 10);
    await merchant.save();

    return res.status(200).json({ success: true, message: 'password_reset_ok' });
  } catch (err) {
    console.error('❌ [backoffice/reset-password]', err);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

module.exports = router;
