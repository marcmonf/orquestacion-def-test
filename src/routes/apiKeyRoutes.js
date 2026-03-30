// src/routes/apiKeyRoutes.js
'use strict';

const express    = require('express');
const router     = express.Router();
const adminAuth  = require('../middleware/adminAuth');
const {
  createApiKey,
  revokeApiKey,
  listApiKeys
} = require('../services/apiKeyService');

/**
 * Endpoints de gestión de API keys — todos protegidos por X-Admin-Token.
 *
 * POST   /api-keys/:merchantId          — crear nueva key
 * GET    /api-keys/:merchantId          — listar keys del merchant
 * DELETE /api-keys/:merchantId/:keyId   — revocar key por ID
 */

// POST /api-keys/:merchantId — crear nueva key
router.post('/:merchantId', adminAuth, async (req, res) => {
  const { merchantId } = req.params;
  const { label = '' } = req.body;

  try {
    const result = await createApiKey(merchantId, label);
    return res.status(201).json({
      success: true,
      message: 'API key creada. Guarda el valor "apiKey" — no se podrá recuperar después.',
      keyId:      result.keyId,
      merchantId: result.merchantId,
      keyPrefix:  result.keyPrefix,
      label:      result.label,
      apiKey:     result.raw   // único momento en que se devuelve en claro
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api-keys/:merchantId — listar keys
router.get('/:merchantId', adminAuth, async (req, res) => {
  const { merchantId } = req.params;
  try {
    const keys = await listApiKeys(merchantId);
    return res.status(200).json({ success: true, merchantId, keys });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api-keys/:merchantId/:keyId — revocar key
router.delete('/:merchantId/:keyId', adminAuth, async (req, res) => {
  const { keyId } = req.params;
  try {
    const revoked = await revokeApiKey(keyId);
    if (!revoked) {
      return res.status(404).json({ success: false, error: 'Key no encontrada' });
    }
    return res.status(200).json({
      success: true,
      message: 'Key revocada correctamente',
      keyPrefix: revoked.keyPrefix,
      revokedAt: revoked.revokedAt
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
