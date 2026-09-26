// src/routes/merchantRoutes.js
//
// Rutas de gestión de MERCHANTS (modelo operativo Merchant — M2 Fase B).
// Protegidas por X-Admin-Token (middleware adminAuth).
//
// Antes este archivo apuntaba a MerchantHierarchy y NO estaba montado en
// index.js (estaba huérfano). Ahora usa el modelo Merchant unificado y se monta
// en '/merchants'. La jerarquía de tiendas se reactivó en M6 Fase 2 como árbol
// por-tenant (modelo HierarchyNode, CRUD en /portal/hierarchy); el campo
// `hierarchyId` del modelo Merchant es un puntero opcional al nodo raíz.
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

// ── Esquemas de validación (compartidos con /backoffice/merchants) ──
// signingSecret ya NO se acepta por API: lo genera el servidor (whsec_...).
const { createSchema, updateSchema } = require('../validators/merchantSchema');
const { generateSigningSecret } = require('../services/webhookDispatcher');

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

    const signingSecret = generateSigningSecret();
    const merchant = new Merchant({ ...value, signingSecret });
    await merchant.save();

    logger.info(`Merchant creado: ${merchant.merchantId}`);
    const out = merchant.toObject();
    delete out.signingSecret; delete out.hmacSecret; delete out.secret; delete out.passwordHash;
    // Secreto de firma de webhooks: se muestra UNA sola vez (como el rawSecret de las API keys).
    res.status(201).json({ message: 'Merchant creado', merchant: out, webhookSigningSecret: signingSecret });
  } catch (err) {
    logger.error(`Error al crear merchant: ${err.message}`);
    res.status(500).json({ error: 'Error al crear merchant' });
  }
});

// ── GET /merchants — listar (con paginación y búsqueda) ──────
router.get('/', async (req, res) => {
  try {
    const { search, status, plan } = req.query;
    const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const query = {};
    if (typeof status === 'string') query.status = status;
    if (typeof plan === 'string')   query.plan   = plan;
    if (typeof search === 'string' && search.trim()) {
      // Entrada escapada: antes iba cruda a new RegExp (ReDoS / 500 con patrón inválido).
      const safe = search.trim().slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(safe, 'i');
      query.$or = [{ name: regex }, { merchantId: regex }, { country: regex }];
    }

    const skip = (page - 1) * limit;
    const [total, merchants] = await Promise.all([
      Merchant.countDocuments(query),
      Merchant.find(query, SAFE_PROJECTION).sort({ merchantId: 1 }).skip(skip).limit(limit).lean(),
    ]);

    res.status(200).json({ page, limit, total, merchants });
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
