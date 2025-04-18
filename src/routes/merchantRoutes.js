const express = require('express');
const router = express.Router();
const Joi = require('joi');
const MerchantHierarchy = require('../models/MerchantHierarchy');

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

// GET /merchants - listar con filtros
router.get('/', async (req, res) => {
  try {
    const { country, group, region, branch, merchantId } = req.query;
    const query = {};
    if (country) query.country = country;
    if (group) query.group = group;
    if (region) query.region = region;
    if (branch) query.branch = branch;
    if (merchantId) query.merchantId = merchantId;

    const merchants = await MerchantHierarchy.find(query).sort({ merchantId: 1 });
    res.status(200).json(merchants);
  } catch (err) {
    console.error('Error al obtener merchants:', err);
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
    res.status(201).json({ message: 'Merchant creado', merchant: newMerchant });
  } catch (err) {
    console.error('Error al crear merchant:', err);
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
    res.status(200).json({ message: 'Merchant actualizado', merchant });
  } catch (err) {
    console.error('Error al actualizar merchant:', err);
    res.status(500).json({ error: 'Error al actualizar merchant' });
  }
});

// DELETE /merchants/:merchantId - eliminar merchant
router.delete('/:merchantId', async (req, res) => {
  try {
    const deleted = await MerchantHierarchy.findOneAndDelete({ merchantId: req.params.merchantId });
    if (!deleted) return res.status(404).json({ error: 'Merchant no encontrado' });
    res.status(200).json({ message: 'Merchant eliminado' });
  } catch (err) {
    console.error('Error al eliminar merchant:', err);
    res.status(500).json({ error: 'Error al eliminar merchant' });
  }
});

module.exports = router;
