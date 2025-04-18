const express = require('express');
const router = express.Router();
const Joi = require('joi');
const MerchantHierarchy = require('../models/MerchantHierarchy');

// Esquema de validación con Joi
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

// POST /merchants - añadir merchant manualmente con validación
router.post('/', async (req, res) => {
  try {
    const { error, value } = merchantSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }

    const newMerchant = new MerchantHierarchy(value);
    await newMerchant.save();
    res.status(201).json({ message: 'Merchant creado', merchant: newMerchant });
  } catch (err) {
    console.error('Error al crear merchant:', err);
    res.status(500).json({ error: 'Error al crear merchant' });
  }
});

module.exports = router;
