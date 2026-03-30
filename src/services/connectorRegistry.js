// src/services/connectorRegistry.js
'use strict';

/**
 * connectorRegistry.js
 *
 * Registro central de conectores de pago disponibles.
 *
 * CONECTORES ACTIVOS:
 *   - dummyCard:  conector de test/simulación, siempre aprueba.
 *   - payNoPain:  adquirente real Paylands (sandbox).
 *
 * Stripe y Adyen son código dummy — ignorar hasta nuevo aviso.
 * Nassau comentado — pendiente de implementación futura.
 */

const dummyCard   = require('../connectors/dummy/dummyCardConnector');
const payNoPain   = require('../connectors/paynopain/payNoPainConnector');

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

    isSoftDecline() { return false; }
  };
}

// ─── Adaptador payNoPain ─────────────────────────────────────────────────────
// payNoPainConnector.authorize devuelve:
//   { success, orderUuid, redirectUrl, responseCode }
// Normalizamos orderUuid → processorReference para que el ciclo de webhooks
// pueda encontrar la transacción por este campo cuando Paylands notifica.
function adaptPayNoPain(connector) {
  return {
    name: 'payNoPain',

    async authorize(paymentData) {
      const result = await connector.authorize(paymentData);
      return {
        success:            result.success === true,
        responseCode:       result.responseCode || (result.success ? 'approved' : 'declined'),
        processorReference: result.orderUuid    || null,   // ← orderUuid de Paylands
        redirectUrl:        result.redirectUrl  || null,   // ← URL de la página de pago
      };
    },

    async capture(data)  { return connector.capture  ? connector.capture(data)  : { status: 'not_supported' }; },
    async void(data)     { return connector.void     ? connector.void(data)     : { status: 'not_supported' }; },
    async refund(data)   { return connector.refund   ? connector.refund(data)   : { status: 'not_supported' }; },

    isSoftDecline(responseCode) {
      // Paylands no hace soft decline en sandbox — siempre hard
      return false;
    }
  };
}

// ─── Registro ────────────────────────────────────────────────────────────────
const registry = {
  dummyCard:  adaptDummy(dummyCard),
  payNoPain:  adaptPayNoPain(payNoPain),
  // nassauBank: adaptNassau(nassauBank),  ← pendiente
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
      `Connector '${name}' not registered. Available: [${Object.keys(registry).join(', ')}]`
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
