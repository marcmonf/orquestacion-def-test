// src/services/connectorRegistry.js
'use strict';

const dummyCard      = require('../connectors/dummy/dummyCardConnector');
const payNoPain      = require('../connectors/paynopain/payNoPainConnector');

function adaptDummy(connector) {
  return {
    name: connector.ID,
    async authorize(paymentData) {
      const result = await connector.authorize(paymentData);
      return {
        success:            result.status === 'approved',
        responseCode:       result.authCode || result.status,
        processorReference: result.transactionId || null,
      };
    },
    async capture(data)  { return connector.capture(data); },
    async void(data)     { return connector.void(data); },
    async refund(data)   { return connector.refund(data); },
    isSoftDecline()      { return false; }
  };
}

const registry = {
  dummyCard: adaptDummy(dummyCard),
  payNoPain: {
    name:           'payNoPain',
    authorize:      payNoPain.authorize,
    isSoftDecline:  payNoPain.isSoftDecline
  }
};

function getConnector(name) {
  const connector = registry[name];
  if (!connector) {
    throw new Error(
      `Connector '${name}' not registered. Available: [${Object.keys(registry).join(', ')}]`
    );
  }
  return connector;
}

function listConnectors() {
  return Object.keys(registry);
}

module.exports = { getConnector, listConnectors };
