const express = require('express');
const router = express.Router();
const Joi = require('joi');
const MerchantHierarchy = require('../models/MerchantHierarchy');
const logger = require('../utils/logger');

// Esquema de validación para creación
const merchantSchema = Joi.object({
  globalGroup: Joi.string().required(),
  country: Joi.string().required(),
  group: Joi.string().required(),
  branch: Joi.string().required(),
  region: Joi.string().required(),
  merchantId: Joi.string().required(),
  name: Joi.string().optional(),
  active: Joi.boolean().optional()
});

// Esquema de validación para actualización
const updateSchema = Joi.object({
  globalGroup: Joi.string(),
  country: Joi.string(),
  group: Joi.string(),
  branch: Joi.string(),
  region: Joi.string(),
  merchantId: Joi.string(),
  name: Joi.string(),
  active: Joi.boolean()
}).min(1);

// GET /merchants - listar con filtros, búsqueda y paginación
router.get('/', async (req, res) => {
  try {
    const {
      globalGroup, country, group, region, branch,
      merchantId, search, active,
      page = 1, limit = 20
    } = req.query;

    const query = {};

    if (globalGroup) query.globalGroup = globalGroup;
    if (country) query.country = country;
    if (group) query.group = group;
    if (region) query.region = region;
    if (branch) query.branch = branch;
    if (merchantId) query.merchantId = merchantId;
    if (active !== undefined) query.active = active === 'true';

    if (search) {
      const regex = new RegExp(search, 'i');
      query.$or = [
        { name: regex },
        { merchantId: regex },
        { branch: regex },
        { group: regex },
        { region: regex },
        { country: regex }
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [total, merchants] = await Promise.all([
      MerchantHierarchy.countDocuments(query),
      MerchantHierarchy.find(query).sort({ merchantId: 1 }).skip(skip).limit(parseInt(limit))
    ]);

    logger.info(`Consulta de merchants - Página ${page}, Filtros: ${JSON.stringify(query)}`);
    res.status(200).json({ page: parseInt(page), limit: parseInt(limit), total, merchants });
  } catch (err) {
    logger.error(`Error al obtener merchants: ${err.message}`);
    res.status(500).json({ error: 'Error al obtener merchants' });
  }
});

// POST /merchants - añadir merchant
router.post('/', async (req, res) => {
  try {
    const { error, value } = merchantSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    const newMerchant = new MerchantHierarchy(value);
    await newMerchant.save();

    logger.info(`Merchant creado - ID: ${newMerchant.merchantId}`);
    res.status(201).json({ message: 'Merchant creado', merchant: newMerchant });
  } catch (err) {
    logger.error(`Error al crear merchant: ${err.message}`);
    res.status(500).json({ error: 'Error al crear merchant' });
  }
});

// PUT /merchants/:merchantId - actualizar merchant
router.put('/:merchantId', async (req, res) => {
  const { error, value } = updateSchema.validate(req.body);
  if (error) return res.status(400).json({ error: error.details[0].message });

  try {
    const merchant = await MerchantHierarchy.findOneAndUpdate(
      { merchantId: req.params.merchantId },
      { $set: value },
      { new: true }
    );
    if (!merchant) return res.status(404).json({ error: 'Merchant no encontrado' });

    logger.info(`Merchant actualizado - ID: ${merchant.merchantId}`);
    res.status(200).json({ message: 'Merchant actualizado', merchant });
  } catch (err) {
    logger.error(`Error al actualizar merchant: ${err.message}`);
    res.status(500).json({ error: 'Error al actualizar merchant' });
  }
});

// DELETE /merchants/:merchantId - eliminar merchant
router.delete('/:merchantId', async (req, res) => {
  try {
    const deleted = await MerchantHierarchy.findOneAndDelete({ merchantId: req.params.merchantId });
    if (!deleted) return res.status(404).json({ error: 'Merchant no encontrado' });

    logger.info(`Merchant eliminado - ID: ${req.params.merchantId}`);
    res.status(200).json({ message: 'Merchant eliminado' });
  } catch (err) {
    logger.error(`Error al eliminar merchant: ${err.message}`);
    res.status(500).json({ error: 'Error al eliminar merchant' });
  }
});

module.exports = router;
