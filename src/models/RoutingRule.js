const mongoose = require('mongoose');

const routingRuleSchema = new mongoose.Schema({
  merchantId:  { type: String, required: true },
  condition:   { type: Object,  required: true }, // e.g. { issuerCountry: "BR" }
  action:      { type: Object,  required: true }, // e.g. { connector: "PSP_LATAM" }
  priority:    { type: Number,  default: 100 }    // menor = más alta
});

routingRuleSchema.index({ merchantId: 1, priority: 1 });

module.exports =
  mongoose.models.RoutingRule ||
  mongoose.model('RoutingRule', routingRuleSchema);
