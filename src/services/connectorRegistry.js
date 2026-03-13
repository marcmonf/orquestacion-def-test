// src/services/connectorRegistry.js
'use strict';

/**
 * connectorRegistry.js
 *
 * Registro central de conectores de pago disponibles.
 *
 * CONECTORES ACTIVOS:
 *   - dummyCard:  conector de test/simulación, siempre aprueba.
 *   - payNoPain:  adquirente real (PayLands / PayNoPain) — sandbox activo.
 *
 * CONECTORES FUTUROS (comentados hasta tener credenciales):
 *   - nassauBank: banco de Nassau, convierte pago a USDT
 *
 * Stripe y Adyen se eliminan como conectores activos — no son adquirentes
 * reales en esta plataforma.
 */

const dummyCard  = require('../connectors/dummy/dummyCardConnector');
const payNoPain  = require('../connectors/paynopain/payNoPainConnector');

// ─── Adaptador dummyCard ─────────────────────────────────────────────────────
// dummyCard devuelve { status, authCode, transactionId, ... }
// paymentService espera  { success, responseCode, processorReference }
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

    isSoftDecline(/* responseCode */) {
      // dummyCard nunca hace soft decline — siempre aprueba
      return false;
    }
  };
}

// ─── Adaptador payNoPain ─────────────────────────────────────────────────────
// payNoPainConnector ya cumple la interfaz estándar Monetiser directamente:
//   authorize() → { success, responseCode, processorReference }
//   isSoftDecline() → boolean
function adaptPayNoPain(connector) {
  return {
    name: connector.ID,

    async authorize(paymentData) { return connector.authorize(paymentData); },
    async capture(data)          { return connector.capture(data); },
    async void(data)             { return connector.void(data); },
    async refund(data)           { return connector.refund(data); },

    isSoftDecline(responseCode)  { return connector.isSoftDecline(responseCode); }
  };
}

// ─── Registro ────────────────────────────────────────────────────────────────
const registry = {
  dummyCard:  adaptDummy(dummyCard),
  payNoPain:  adaptPayNoPain(payNoPain),

  // nassauBank: new NassauBankConnector(process.env.NASSAU_API_KEY),
};

/**
 * Obtiene un conector por nombre.
 * @param {string} name
 * @returns {{ name: string, authorize: Function, isSoftDecline: Function }}
 */
function getConnector(name) {
  const connector = registry[name];
  if (!connector) {
    throw new Error(
      `Connector '${name}' not registered. Registered connectors: [${Object.keys(registry).join(', ')}]`
    );
  }
  return connector;
}

/**
 * Lista los nombres de conectores disponibles.
 * @returns {string[]}
 */
function listConnectors() {
  return Object.keys(registry);
}

module.exports = { getConnector, listConnectors };
