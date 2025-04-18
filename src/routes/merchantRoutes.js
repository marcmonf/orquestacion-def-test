const express = require('express');
const router = express.Router();
const MerchantHierarchy = require('../models/MerchantHierarchy');

// GET /merchants - listar todos
router.get('/', async (req, res) => {
  try {
    const merchants = await MerchantHierarchy.find().sort({ merchantId: 1 });
    res.status(200).json(merchants);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener merchants' });
  }
});

// POST /merchants - añadir merchant manualmente (opcional)
router.post('/', async (req, res) => {
  try {
    const data = req.body;
    const newMerchant = new MerchantHierarchy(data);
    await newMerchant.save();
    res.status(201).json({ message: 'Merchant creado', merchant: newMerchant });
  } catch (err) {
    res.status(500).json({ error: 'Error al crear merchant' });
  }
});

module.exports = router;
