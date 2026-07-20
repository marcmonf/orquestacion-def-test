// src/routes/portalRoutes.js
'use strict';
//
// PORTAL del merchant (M6 Fase 1) — endpoints protegidos por sesión de portal.
//
// AISLAMIENTO DE TENANT (requisito duro): el merchantId sale SIEMPRE de
// req.portalUser.merchantId (la sesión JWT), NUNCA del body/param/query. Todo
// recurso se resuelve con el merchantId de sesión en el filtro, de modo que un
// usuario de OTRO merchant sencillamente no existe para esta sesión (404, no se
// revela su existencia). Es la lección del bug cross-tenant de PUT/DELETE
// /transactions (DEV-LOG §4): ese patrón no se repite.
//
const express      = require('express');
const router       = express.Router();
const MerchantUser = require('../models/MerchantUser');
const portalAuth   = require('../middleware/portalAuth');
const { requirePortalRole, requirePasswordChanged } = portalAuth;
const { toPublicUser }        = require('../utils/publicUser');
const { generateTempPassword } = require('../utils/tempPassword');

let bcrypt;
try { bcrypt = require('bcryptjs'); } catch {
  try { bcrypt = require('bcrypt'); } catch { console.error('❌ bcrypt/bcryptjs no instalado'); }
}

const VALID_ROLES = ['merchant_admin', 'merchant_operator', 'merchant_viewer'];

// Todo el portal exige sesión válida.
router.use(portalAuth);

// ─────────────────────────────────────────────
// GET /portal/me — datos del usuario de sesión.
// Permitido bajo mustChangePassword (el usuario necesita saber quién es y que
// debe cambiar la password). Se resuelve con merchantId de sesión.
// ─────────────────────────────────────────────
router.get('/me', async (req, res) => {
  try {
    const user = await MerchantUser.findOne({
      _id:        req.portalUser.userId,
      merchantId: req.portalUser.merchantId,
    });
    if (!user) return res.status(404).json({ success: false, error: 'user_not_found' });
    return res.json({ success: true, user: toPublicUser(user) });
  } catch (err) {
    console.error('❌ [portal/me]', err);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

// A partir de aquí, el usuario DEBE haber cambiado la password temporal.
router.use(requirePasswordChanged);

// ─────────────────────────────────────────────
// GET /portal/users — usuarios del PROPIO merchant (solo merchant_admin)
// ─────────────────────────────────────────────
router.get('/users', requirePortalRole('merchant_admin'), async (req, res) => {
  try {
    const users = await MerchantUser
      .find({ merchantId: req.portalUser.merchantId })   // ← scope de la SESIÓN, no del cliente
      .select('-passwordHash')
      .sort({ createdAt: -1 })
      .lean();
    return res.json({ success: true, users: users.map(toPublicUser) });
  } catch (err) {
    console.error('❌ [portal/users GET]', err);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

// ─────────────────────────────────────────────
// POST /portal/users — crear usuario en el PROPIO merchant (solo merchant_admin)
// Genera password temporal (visible UNA vez) + mustChangePassword=true.
// ─────────────────────────────────────────────
router.post('/users', requirePortalRole('merchant_admin'), async (req, res) => {
  if (!bcrypt) return res.status(500).json({ success: false, error: 'dependencies_missing' });

  const { name, email, role } = req.body || {};
  if (!name || !email || !role) {
    return res.status(400).json({ success: false, error: 'name_email_role_required' });
  }
  if (!VALID_ROLES.includes(role)) {
    return res.status(400).json({ success: false, error: 'invalid_role' });
  }

  try {
    const normEmail = String(email).toLowerCase().trim();
    const existing = await MerchantUser.findOne({ email: normEmail });
    if (existing) return res.status(409).json({ success: false, error: 'email_already_exists' });

    const tempPassword = generateTempPassword();
    const passwordHash = await bcrypt.hash(tempPassword, 10);

    const user = await MerchantUser.create({
      merchantId:         req.portalUser.merchantId,   // ← SIEMPRE el de la sesión; se ignora cualquier merchantId del body
      email:              normEmail,
      passwordHash,
      name,
      role,
      active:             true,
      mustChangePassword: true,
      createdBy:          req.portalUser.email || null,
    });

    return res.status(201).json({
      success: true,
      message: 'Usuario creado. Entrega la password temporal por un canal seguro — no se volverá a mostrar.',
      tempPassword,                       // visible UNA sola vez
      user: toPublicUser(user),
    });
  } catch (err) {
    console.error('❌ [portal/users POST]', err);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

// ─────────────────────────────────────────────
// PATCH /portal/users/:userId — editar nombre/rol/estado dentro del PROPIO merchant
// Resuelve SIEMPRE con merchantId de sesión: un usuario de otro merchant → 404.
// ─────────────────────────────────────────────
router.patch('/users/:userId', requirePortalRole('merchant_admin'), async (req, res) => {
  try {
    const user = await MerchantUser.findOne({
      _id:        req.params.userId,
      merchantId: req.portalUser.merchantId,   // ← el filtro que impide tocar recursos ajenos
    });
    if (!user) return res.status(404).json({ success: false, error: 'user_not_found' });

    const isSelf = String(user._id) === String(req.portalUser.userId);

    if (req.body.role !== undefined) {
      if (!VALID_ROLES.includes(req.body.role)) {
        return res.status(400).json({ success: false, error: 'invalid_role' });
      }
      // Un admin no puede degradarse a sí mismo (evita quedarse sin ningún admin).
      if (isSelf && req.body.role !== 'merchant_admin') {
        return res.status(409).json({ success: false, error: 'cannot_demote_yourself' });
      }
      user.role = req.body.role;
    }

    if (req.body.active !== undefined) {
      if (isSelf && req.body.active === false) {
        return res.status(409).json({ success: false, error: 'cannot_deactivate_yourself' });
      }
      user.active = !!req.body.active;
    }

    if (req.body.name !== undefined) {
      if (!String(req.body.name).trim()) {
        return res.status(400).json({ success: false, error: 'name_cannot_be_empty' });
      }
      user.name = String(req.body.name).trim();
    }

    await user.save();
    return res.json({ success: true, user: toPublicUser(user) });
  } catch (err) {
    console.error('❌ [portal/users PATCH]', err);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

module.exports = router;
