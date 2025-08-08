const StripeConnector = require('../connectors/StripeConnector');
const AdyenConnector  = require('../connectors/AdyenConnector');

const registry = {
  stripe: new StripeConnector(process.env.STRIPE_API_KEY),
  adyen : new AdyenConnector(process.env.ADYEN_API_KEY, process.env.ADYEN_MERCHANT_ACCOUNT),
};

/**
 * @param {string} name
 * @returns {import('../connectors/PaymentConnector')}
 */
function getConnector(name) {
  const connector = registry[name];
  if (!connector) throw new Error(`Connector '${name}' not registered`);
  return connector;
}

module.exports = { getConnector };
