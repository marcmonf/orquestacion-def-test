const express = require('express');
const router = express.Router();
const MerchantHierarchy = require('../models/MerchantHierarchy');

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

// POST /merchants - añadir merchant manualmente
router.post('/', async (req, res) => {
  try {
    const data = req.body;
    const newMerchant = new MerchantHierarchy(data);
    await newMerchant.save();
    res.status(201).json({ message: 'Merchant creado', merchant: newMerchant });
  } catch (err) {
    console.error('Error al crear merchant:', err.message, err.stack);
    res.status(500).json({ error: 'Error al crear merchant' });
  }
});

module.exports = router;
