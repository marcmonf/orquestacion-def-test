'use strict';

const MerchantRules = require('../models/MerchantRules');
const { policySchema } = require('../validators/policySchema');

function defaultPolicy(merchantId) {
  return {
    merchantId,
    version: 'v1',
    defaultConnector: 'dummyCard',
    rules: [],
    fallback: { order: ['dummyCard'], on: ['network_error','soft_decline'] },
    retries: { soft_decline: 1, network_error: 2, jitterMs: [200,500] },
    explain: true
  };
}

async function getPolicy(req, res) {
  const { merchantId } = req.params;
  const doc = await MerchantRules.findOne({ merchantId }).lean();
  const policy = doc?.policy || defaultPolicy(merchantId);
  return res.status(200).json({ success: true, policy });
}

async function validatePolicy(req, res) {
  const { error, value } = policySchema.validate(req.body, { abortEarly: false });
  if (error) {
    return res.status(400).json({
      success: false,
      errors: error.details.map(d => ({ path: d.path.join('.'), message: d.message }))
    });
  }
  return res.status(200).json({ success: true, normalized: value });
}

async function upsertPolicy(req, res) {
  const { merchantId } = req.params;
  const body = { ...req.body, merchantId };

  const { error, value } = policySchema.validate(body, { abortEarly: false });
  if (error) {
    return res.status(400).json({
      success: false,
      errors: error.details.map(d => ({ path: d.path.join('.'), message: d.message }))
    });
  }

  const now = new Date();
  const updated = await MerchantRules.findOneAndUpdate(
    { merchantId },
    { $set: { policy: value, updatedAt: now }, $setOnInsert: { createdAt: now } },
    { new: true, upsert: true }
  ).lean();

  return res.status(200).json({ success: true, policy: updated.policy });
}

module.exports = { getPolicy, validatePolicy, upsertPolicy };
