// src/services/connectorRegistry.js
'use strict';

/**
 * connectorRegistry.js
 *
 * Registro central de conectores de pago disponibles.
 *
 * CONECTORES:
 *   - payNoPain:  adquirente real Paylands. Conector por defecto.
 *   - stripe:     Stripe con la cuenta del comercio (FEATURE_STRIPE, apagado
 *                 por defecto; sesión 5 nov 2026).
 *   - dummyCard:  conector SIMULADO, aprueba SIEMPRE sin mover dinero. Solo se
 *                 registra en development/test o con ALLOW_DUMMY_CONNECTOR=true.
 *
 * Por qué dummyCard ya no está siempre registrado (26 sep 2026): era la política
 * por defecto de TODO merchant sin reglas y además el fallback que el validador
 * de políticas añadía por su cuenta. Resultado: un pago que Paylands rechazaba o
 * que fallaba por red podía acabar "authorized" por el simulador, sin cobrar a
 * nadie. Un servidor con dinero real no debe tener un conector que aprueba todo.
 *
 * FRAMEWORK MULTI-PSP (nov 2026). Dos vistas de cada conector:
 *   - getProvider(id): el conector según el CONTRATO único
 *     (src/connectors/contract.js): capacidades + operaciones normalizadas. Es
 *     lo que usan el routing, el checkout y todo código nuevo.
 *   - getConnector(id): el adaptador LEGADO { authorize, capture, void, refund,
 *     isSoftDecline } que usan paymentService y paymentLifecycleService. Para
 *     Paylands y dummyCard es exactamente el de antes (el cable no cambia:
 *     tests/golden/paylandsWire.test.js). Para un conector nuevo se genera a
 *     partir del contrato (legacyFromProvider), así el núcleo no se toca.
 *
 * Añadir un PSP: docs/conectores.md.
 */

const dummyCard   = require('../connectors/dummy/dummyCardConnector');
const payNoPain   = require('../connectors/paynopain/payNoPainConnector');
const payNoPainProvider = require('../connectors/paylands');
const dummyProvider     = require('../connectors/dummy');
const { isDevOrTest } = require('../utils/runtimeSecrets');
const flags = require('../utils/featureFlags');

const DEFAULT_CONNECTOR = 'payNoPain';

function dummyEnabled() {
  return isDevOrTest() || String(process.env.ALLOW_DUMMY_CONNECTOR || '').toLowerCase() === 'true';
}

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

    async capture(data) {
      const result = await connector.capture(data);
      return {
        success:       result?.status === 'captured',
        status:        result?.status,
        capturedTotal: result?.amount ?? data.amount ?? null,
        raw:           result,
      };
    },
    async void(data) {
      const result = await connector.void(data);
      return {
        success: result?.status === 'voided',
        status:  result?.status,
        raw:     result,
      };
    },
    async refund(data) {
      const result = await connector.refund(data);
      return {
        success:       result?.status === 'refunded',
        status:        result?.status,
        refundedTotal: result?.amount ?? data.amount ?? null,
        raw:           result,
      };
    },

    isSoftDecline() { return false; }
  };
}

// ─── Adaptador payNoPain ─────────────────────────────────────────────────────
// payNoPainConnector.authorize devuelve (flujo S2S tokens-only, sobre chargeWithToken):
//   { success, requires3DS, threeDsUrl, responseCode, processorReference, orderUuid }
// Normalizamos processorReference (orderUuid de Paylands) para que el ciclo de
// webhooks pueda encontrar la transacción por este campo cuando Paylands notifica.
// requires3DS/threeDsUrl se propagan tal cual: el flujo tokenizado SIEMPRE pasa
// por un challenge 3DS y paymentService debe distinguirlo de un decline.
function adaptPayNoPain(connector) {
  return {
    name: 'payNoPain',

    async authorize(paymentData) {
      const result = await connector.authorize(paymentData);
      return {
        success:            result.success === true,
        requires3DS:        result.requires3DS === true,
        threeDsUrl:         result.threeDsUrl  || null,   // ← URL de challenge 3DS tokenizado
        responseCode:       result.responseCode || (result.success ? 'approved' : 'declined'),
        processorReference: result.processorReference || result.orderUuid || null,   // ← orderUuid de Paylands
        redirectUrl:        result.redirectUrl  || null,   // ← URL de la página de pago (flujo hosted)
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

// ─── Adaptador genérico: contrato → interfaz legada ──────────────────────────
// Para conectores nuevos. Traduce las respuestas normalizadas del contrato a lo
// que esperan paymentService y paymentLifecycleService (que no se tocan).
function legacyFromProvider(provider) {
  const errText = (r) => (r && r.error ? (r.error.code || String(r.error)) : undefined);
  return {
    name: provider.id,
    async authorize(paymentData, ctx) {
      const r = await provider.createPayment({ ...paymentData, sourceToken: paymentData.cardToken || paymentData.sourceToken }, ctx);
      return {
        success:            r.status === 'authorized' || r.status === 'captured',
        requires3DS:        r.status === 'requires_action',
        threeDsUrl:         r.action && r.action.url ? r.action.url : null,
        responseCode:       r.error ? r.error.code : r.status,
        processorReference: r.processorReference || null,
      };
    },
    async capture(data, ctx) { const r = await provider.capture(data, ctx); return { ...r, error: errText(r) }; },
    async void(data, ctx)    { const r = await provider.cancel(data, ctx);  return { ...r, error: errText(r) }; },
    async refund(data, ctx)  { const r = await provider.refund(data, ctx);  return { ...r, error: errText(r) }; },
    isSoftDecline() { return false; },
  };
}

// ─── Registro ────────────────────────────────────────────────────────────────
const registry = {
  payNoPain:  adaptPayNoPain(payNoPain),
  // nassauBank: adaptNassau(nassauBank),  ← pendiente
};
const providers = {
  payNoPain: payNoPainProvider,
};
if (dummyEnabled()) {
  registry.dummyCard = adaptDummy(dummyCard);
  providers.dummyCard = dummyProvider;
}
// Stripe (sesión 5 nov 2026, F1): segundo PSP real, con la cuenta Stripe DEL
// COMERCIO. Solo con FEATURE_STRIPE=true (apagado por defecto). Un conector
// nuevo usa el adaptador legado generado desde el contrato: el núcleo no cambia.
if (flags.stripe()) {
  const stripeProvider = require('../connectors/stripe');
  providers.stripe = stripeProvider;
  registry.stripe = legacyFromProvider(stripeProvider);
}

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

/** Conector según el contrato (capacidades + operaciones normalizadas). */
function getProvider(name) {
  const p = providers[name];
  if (!p) throw new Error(`Provider '${name}' not registered. Available: [${Object.keys(providers).join(', ')}]`);
  return p;
}

function hasProvider(name) {
  return Object.prototype.hasOwnProperty.call(providers, name);
}

/** [{ id, displayName, capabilities }] de los conectores registrados. */
function listProviders() {
  return Object.values(providers).map((p) => ({ id: p.id, displayName: p.displayName, capabilities: p.capabilities }));
}

/**
 * Registra un conector que cumple el contrato. Para conectores reales se añade
 * a mano arriba (con su require); esta función existe para los TESTS (conector
 * de prueba "B") y se niega a funcionar fuera de development/test, igual que
 * cualquier conector marcado testOnly o simulated.
 */
function registerProvider(provider) {
  if (!provider || !provider.id || typeof provider.createPayment !== 'function') {
    throw new Error('registerProvider: el conector no cumple el contrato (usa defineConnector)');
  }
  if (!isDevOrTest()) {
    throw new Error(`registerProvider('${provider.id}') solo está permitido en development/test`);
  }
  providers[provider.id] = provider;
  registry[provider.id] = legacyFromProvider(provider);
  return provider;
}

function unregisterProvider(id) {
  if (!isDevOrTest()) throw new Error('unregisterProvider solo en development/test');
  if (id === 'payNoPain') throw new Error('payNoPain no se puede desregistrar');
  delete providers[id];
  delete registry[id];
}

module.exports = {
  getConnector, listConnectors, DEFAULT_CONNECTOR,
  getProvider, hasProvider, listProviders, registerProvider, unregisterProvider, legacyFromProvider,
};
