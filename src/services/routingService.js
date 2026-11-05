// src/services/routingService.js
'use strict';
//
// ROUTING PRE-CAPTURA (framework multi-PSP, nov 2026).
//
// Decide a qué conector (PSP) va un pago ANTES de pedir la tarjeta: al crear la
// sesión de checkout. Así el checkout pinta los campos del PSP elegido y el
// token que salga de ellos solo sirve en ese PSP.
//
// Cómo decide:
//   1. Política del merchant (MerchantRules.policy, la misma de /admin →
//      Reglas) evaluada con ruleEngineV2 sobre: importe, divisa, país del
//      comprador, método de pago (y lo que la política use). → conector primario.
//   2. Lista de candidatos: primario + policy.fallback.order + (en checkout) el
//      conector por defecto de la plataforma.
//   3. Se queda con el PRIMERO que: está registrado · soporta método/divisa/país
//      (capacidades del contrato) · tiene proveedor de campos disponible en el
//      checkout · tiene credenciales para el modo (cuenta del merchant o de
//      plataforma) · está sano (circuit breaker).
//   4. Si ninguno está sano pero alguno es capaz, se usa el primero capaz (un
//      breaker abierto no deja sin cobrar si no hay alternativa — es lo que
//      pasaba antes con un único PSP).
//   5. Si ninguno es capaz (p. ej. una divisa que ningún PSP registrado
//      procesa) → sin conector: la sesión no se crea (422 no_connector_available).
//      Antes se habría mandado a Paylands, que cobra en la divisa de su servicio.
//
// INVARIANTE 5: este es el ÚNICO sitio con failover, y ocurre antes de que el
// comprador vea un campo de tarjeta. Nunca después de un rechazo o un timeout.
//
// Cada transacción guarda la decisión completa (Transaction.routing) con su
// explain: qué regla casó, qué candidatos se descartaron y por qué.

const MerchantRules = require('../models/MerchantRules');
const registry = require('./connectorRegistry');
const health = require('./connectorHealth');
const accounts = require('./connectorAccountService');
const { evaluate } = require('../rules/ruleEngineV2');
const { supports } = require('../connectors/contract');
const { canQuery } = require('../utils/dbReady');

// Proveedores de campos que el checkout de Monetiser sabe pintar hoy
// (public/checkout/providers/). Un conector cuyo proveedor no esté aquí no
// recibe checkouts (sí podría recibir S2S).
// 'stripe_elements' (5 nov 2026): solo recibe pagos si el conector Stripe está
// registrado (FEATURE_STRIPE) y el comercio tiene su cuenta Stripe configurada.
// 'redsys_redirect' (6 nov 2026): redirección a la página de pago de Redsys.
const CHECKOUT_FIELDS_PROVIDERS = Object.freeze(['paylands_proxyfields', 'stripe_elements', 'redsys_redirect']);
// Solo tests: proveedores de campos de conectores de prueba (nunca en producción).
const testFieldsProviders = new Set();
function checkoutFieldsProviders() {
  return [...CHECKOUT_FIELDS_PROVIDERS, ...testFieldsProviders];
}

function defaultPolicy(merchantId) {
  return { merchantId, version: 'v1', defaultConnector: registry.DEFAULT_CONNECTOR, rules: [] };
}

async function loadPolicy(merchantId) {
  if (!canQuery(MerchantRules)) return { policy: defaultPolicy(merchantId), source: 'default_db_unavailable' };
  const doc = await MerchantRules.findOne({ merchantId }).lean();
  return doc && doc.policy ? { policy: doc.policy, source: 'merchant' } : { policy: defaultPolicy(merchantId), source: 'default' };
}

/**
 * @param {object} p
 * @param {string} p.merchantId
 * @param {number} p.amount         céntimos
 * @param {string} p.currency
 * @param {string} [p.country]      país del comprador (ISO alfa-2), si se conoce
 * @param {string} [p.paymentMethod] 'card' por defecto
 * @param {boolean} [p.livemode]
 * @param {'checkout'|'s2s'} [p.channel]
 * @returns {Promise<{ connector:(string|null), accountId:(string|null), mode:string, ... }>}
 */
async function decide({ merchantId, amount, currency, country = null, paymentMethod = 'card', livemode = false, channel = 'checkout' }) {
  const decidedAt = new Date().toISOString();
  const mode = accounts.modeOf(livemode);
  const { policy, source } = await loadPolicy(merchantId);
  const ctx = { amount, currency, country: country || null, paymentMethod, method: paymentMethod };
  const ev = evaluate(policy, ctx, { explain: true });

  const primary = ev.connector || policy.defaultConnector || registry.DEFAULT_CONNECTOR;
  const order = [primary, ...((policy.fallback && policy.fallback.order) || [])];
  if (channel === 'checkout') order.push(registry.DEFAULT_CONNECTOR);
  const unique = order.filter((c, i) => c && order.indexOf(c) === i);

  const candidates = [];
  for (const id of unique) {
    const c = { connector: id, capable: false, healthy: null, accountId: null, reasons: [] };
    candidates.push(c);
    if (!registry.hasProvider(id)) { c.reasons.push('no registrado'); continue; }
    const provider = registry.getProvider(id);
    if (provider.capabilities.simulated && channel === 'checkout') { c.reasons.push('simulado: no recibe checkouts'); continue; }
    const sup = supports(provider, { method: paymentMethod, currency, country });
    if (!sup.ok) { c.reasons.push(...sup.reasons); continue; }
    if (channel === 'checkout' && !checkoutFieldsProviders().includes(provider.capabilities.checkout.fieldsProvider)) {
      c.reasons.push(`sin proveedor de campos disponible en el checkout (${provider.capabilities.checkout.fieldsProvider || 'ninguno'})`);
      continue;
    }
    let account = null;
    try { account = await accounts.resolveContext({ merchantId, connector: id, livemode }); } catch (_) { account = null; }
    if (!account) { c.reasons.push(`sin credenciales para el modo ${mode}`); continue; }
    c.capable = true;
    c.accountId = account.accountId;
    c.healthy = health.isAvailable(id);
    if (!c.healthy) c.reasons.push(`circuito ${health.statusOf(id)}`);
  }

  const healthy = candidates.find((c) => c.capable && c.healthy);
  const capable = candidates.find((c) => c.capable);
  const chosen = healthy || capable || null;

  let reason;
  if (!chosen) reason = 'no_connector_available';
  else if (!healthy) reason = 'all_unhealthy_using_first_capable';
  else if (chosen.connector !== primary) reason = 'failover_pre_card';
  else reason = ev.matchedRuleId ? 'rule' : 'default';

  return {
    connector: chosen ? chosen.connector : null,
    accountId: chosen ? chosen.accountId : null,
    mode,
    channel,
    reason,
    matchedRuleId: ev.matchedRuleId || null,
    primary,
    policySource: source,
    context: { amount, currency, country: country || null, paymentMethod },
    reasons: ev.reasons,
    explain: ev.explain || [],
    candidates,
    fieldsProvider: chosen ? registry.getProvider(chosen.connector).capabilities.checkout.fieldsProvider : null,
    decidedAt,
  };
}

/**
 * Para los flujos que NO pueden quedarse sin conector por un fallo del propio
 * routing (p. ej. Mongo caído leyendo la política): decisión de plataforma por
 * defecto, marcada como tal en el explain. Mantiene el comportamiento anterior
 * al framework (todo checkout iba a Paylands).
 */
function platformDefault({ amount, currency, livemode = false, channel = 'checkout', error }) {
  return {
    connector: registry.DEFAULT_CONNECTOR,
    accountId: 'platform',
    mode: accounts.modeOf(livemode),
    channel,
    reason: 'routing_error_platform_default',
    matchedRuleId: null,
    primary: registry.DEFAULT_CONNECTOR,
    policySource: 'none',
    context: { amount, currency },
    reasons: [`routing no disponible: ${error || 'error'}`],
    explain: [],
    candidates: [],
    fieldsProvider: registry.getProvider(registry.DEFAULT_CONNECTOR).capabilities.checkout.fieldsProvider,
    decidedAt: new Date().toISOString(),
  };
}

async function decideSafe(params) {
  try {
    return await decide(params);
  } catch (err) {
    // Pagos reales: si el routing no puede decidir, NO se crea el pago
    // (revisión 5 nov, M2). Pruebas: comportamiento anterior (Paylands).
    if (params && params.livemode) {
      return { connector: null, accountId: null, mode: 'live', channel: params.channel || 'checkout', reason: 'routing_error', reasons: [`routing no disponible: ${err && err.message}`], candidates: [], explain: [], fieldsProvider: null, decidedAt: new Date().toISOString() };
    }
    const fallback = platformDefault({ ...params, error: err && err.message });
    // Ni siquiera el fallback puede ir a un entorno de otro modo.
    const ok = await accounts.resolveContext({ merchantId: params.merchantId, connector: fallback.connector, livemode: false }).catch(() => null);
    return ok ? fallback : { ...fallback, connector: null, accountId: null, fieldsProvider: null, reason: 'routing_error' };
  }
}

const { isDevOrTest } = require('../utils/runtimeSecrets');
const _testing = {
  allowFieldsProvider(id) { if (!isDevOrTest()) throw new Error('solo en development/test'); testFieldsProviders.add(id); },
  reset() { testFieldsProviders.clear(); },
};

module.exports = { decide, decideSafe, platformDefault, CHECKOUT_FIELDS_PROVIDERS, checkoutFieldsProviders, loadPolicy, _testing };
