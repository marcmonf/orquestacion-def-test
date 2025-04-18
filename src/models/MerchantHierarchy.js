const mongoose = require('mongoose');

const merchantHierarchySchema = new mongoose.Schema({
  merchantId: { type: String, required: true, unique: true },
  branch: { type: String, required: true },
  region: { type: String },
  group: { type: String },
  country: { type: String },
  globalGroup: { type: String },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('MerchantHierarchy', merchantHierarchySchema);
