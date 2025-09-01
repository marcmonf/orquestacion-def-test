'use strict';

const mongoose = require('mongoose');

const IframeNonceSchema = new mongoose.Schema(
  {
    merchantId: { type: String, required: true, index: true },
    paymentId: { type: String, required: true, index: true },
    nonce: { type: String, required: true, unique: true },
    exp: { type: Date, required: true, index: true },
    usedAt: { type: Date },
    createdAt: { type: Date, default: Date.now }
  },
  { collection: 'IframeNonces' }
);

IframeNonceSchema.index({ exp: 1 }, { expireAfterSeconds: 0 });

IframeNonceSchema.statics.consumeIfValid = async function ({ merchantId, paymentId, nonce, now = new Date() }) {
  const doc = await this.findOne({ merchantId, paymentId, nonce }).lean();
  if (!doc) return { ok: false, reason: 'nonce_not_found' };
  if (doc.usedAt) return { ok: false, reason: 'nonce_already_used' };
  if (doc.exp <= now) return { ok: false, reason: 'nonce_expired' };
  const res = await this.updateOne(
    { merchantId, paymentId, nonce, usedAt: { $exists: false }, exp: { $gt: now } },
    { $set: { usedAt: now } }
  );
  if (res.modifiedCount !== 1) return { ok: false, reason: 'race_condition' };
  return { ok: true };
};

module.exports = mongoose.model('IframeNonce', IframeNonceSchema);
