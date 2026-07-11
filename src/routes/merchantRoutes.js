// src/routes/merchantRoutes.js
//
// Rutas de gestión de MERCHANTS (modelo operativo Merchant — M2 Fase B).
// Protegidas por X-Admin-Token (middleware adminAuth).
//
// Antes este archivo apuntaba a MerchantHierarchy y NO estaba montado en
// index.js (estaba huérfano). Ahora usa el modelo Merchant unificado y se monta
// en '/merchants'. La jerarquía corporativa (MerchantHierarchy) queda en standby;
// el puente es el campo `hierarchyId` del modelo Merchant.
//
'use strict';

const express   = require('express');
const router    = express.Router();
const Joi        = require('joi');
const Merchant   = require('../models/Merchant');
const adminAuth  = require('../middleware/adminAuth');
const logger     = require('../utils/logger');

// Todas las rutas de gestión de merchants requieren X-Admin-Token
router.use(adminAuth);

// ── Esquemas de validación ───────────────────────────────────
const brandingSchema = Joi.object({
  logoUrl:      Joi.string().allow('', null),
  primaryColor: Joi.string().allow('', null),
  accentColor:  Joi.string().allow('', null),
  merchantName: Joi.string().allow('', null),
});

const createSchema = Joi.object({
  merchantId:    Joi.string().required(),
  name:          Joi.string().allow('', null),
  country:       Joi.string().allow('', null),
  plan:          Joi.string().valid('free', 'starter', 'growth', 'enterprise'),
  status:        Joi.string().valid('active', 'suspended', 'pending'),
  webhookUrl:    Joi.string().uri().allow('', null),
  serviceUuid:   Joi.string().allow('', null),
  templateUuid:  Joi.string().allow('', null),
  signingSecret: Joi.string().allow('', null),
  branding:      brandingSchema,
  // branding plano legacy (compatibilidad)
  logoUrl:       Joi.string().allow('', null),
  brandColor:    Joi.string().allow('', null),
  accentColor:   Joi.string().allow('', null),
  hierarchyId:   Joi.string().allow(null),
});

const updateSchema = Joi.object({
  name:          Joi.string().allow('', null),
  country:       Joi.string().allow('', null),
  plan:          Joi.string().valid('free', 'starter', 'growth', 'enterprise'),
  status:        Joi.string().valid('active', 'suspended', 'pending'),
  webhookUrl:    Joi.string().uri().allow('', null),
  serviceUuid:   Joi.string().allow('', null),
  templateUuid:  Joi.string().allow('', null),
  signingSecret: Joi.string().allow('', null),
  branding:      brandingSchema,
  logoUrl:       Joi.string().allow('', null),
  brandColor:    Joi.string().allow('', null),
  accentColor:   Joi.string().allow('', null),
  hierarchyId:   Joi.string().allow(null),
}).min(1);

// signingSecret nunca se devuelve en las respuestas
const SAFE_PROJECTION = { signingSecret: 0, hmacSecret: 0, secret: 0, passwordHash: 0 };

// ── POST /merchants — crear merchant ─────────────────────────
router.post('/', async (req, res) => {
  try {
    const { error, value } = createSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    const exists = await Merchant.findOne({ merchantId: value.merchantId }).lean();
    if (exists) {
      return res.status(409).json({ error: `merchant '${value.merchantId}' ya existe` });
    }

    const merchant = new Merchant(value);
    await merchant.save();

    logger.info(`Merchant creado: ${merchant.merchantId}`);
    const out = merchant.toObject();
    delete out.signingSecret; delete out.hmacSecret; delete out.secret; delete out.passwordHash;
    res.status(201).json({ message: 'Merchant creado', merchant: out });
  } catch (err) {
    logger.error(`Error al crear merchant: ${err.message}`);
    res.status(500).json({ error: 'Error al crear merchant' });
  }
});

// ── GET /merchants — listar (con paginación y búsqueda) ──────
router.get('/', async (req, res) => {
  try {
    const { search, status, plan, page = 1, limit = 20 } = req.query;
    const query = {};
    if (status) query.status = status;
    if (plan)   query.plan   = plan;
    if (search) {
      const regex = new RegExp(search, 'i');
      query.$or = [{ name: regex }, { merchantId: regex }, { country: regex }];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [total, merchants] = await Promise.all([
      Merchant.countDocuments(query),
      Merchant.find(query, SAFE_PROJECTION).sort({ merchantId: 1 }).skip(skip).limit(parseInt(limit)).lean(),
    ]);

    res.status(200).json({ page: parseInt(page), limit: parseInt(limit), total, merchants });
  } catch (err) {
    logger.error(`Error al listar merchants: ${err.message}`);
    res.status(500).json({ error: 'Error al listar merchants' });
  }
});

// ── GET /merchants/:merchantId — detalle ─────────────────────
router.get('/:merchantId', async (req, res) => {
  try {
    const merchant = await Merchant.findOne({ merchantId: req.params.merchantId }, SAFE_PROJECTION).lean();
    if (!merchant) return res.status(404).json({ error: 'Merchant no encontrado' });
    res.status(200).json({ merchant });
  } catch (err) {
    logger.error(`Error al obtener merchant: ${err.message}`);
    res.status(500).json({ error: 'Error al obtener merchant' });
  }
});

// ── PATCH /merchants/:merchantId — actualizar ────────────────
router.patch('/:merchantId', async (req, res) => {
  try {
    const { error, value } = updateSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    const merchant = await Merchant.findOneAndUpdate(
      { merchantId: req.params.merchantId },
      { $set: value },
      { new: true, projection: SAFE_PROJECTION }
    ).lean();

    if (!merchant) return res.status(404).json({ error: 'Merchant no encontrado' });

    logger.info(`Merchant actualizado: ${req.params.merchantId}`);
    res.status(200).json({ message: 'Merchant actualizado', merchant });
  } catch (err) {
    logger.error(`Error al actualizar merchant: ${err.message}`);
    res.status(500).json({ error: 'Error al actualizar merchant' });
  }
});

module.exports = router;
