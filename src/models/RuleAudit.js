'use strict';
const mongoose = require('mongoose');

const RuleAuditSchema = new mongoose.Schema({
  merchantId: { type: String, index: true },
  actor: { type: String, default: 'unknown' },
  ip: { type: String },
  prevHash: { type: String },
  nextHash: { type: String },
  diffSize: { type: Number },
  changedFields: { type: [String], default: [] },
  createdAt: { type: Date, default: Date.now }
}, { collection: 'RuleAudit' });

module.exports = mongoose.models.RuleAudit ||
  mongoose.model('RuleAudit', RuleAuditSchema);
