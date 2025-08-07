// src/rules/ruleEngine.js
const Rule = require('../models/RoutingRule');

/** Decide conector basado en reglas y transacción ya enriquecida */
async function decideConnector(tx) {
  const rules = await Rule.find({ merchantId: tx.merchantId }).lean();

  for (const r of rules) {
    const match = Object.entries(r.condition).every(
      ([k, v]) => tx[k] && tx[k].toString().toLowerCase() === v.toString().toLowerCase()
    );
    if (match) return r.action.connector;
  }
  // Default
  return 'PSP_DEFAULT';
}

module.exports = { decideConnector };
