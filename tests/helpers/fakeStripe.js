// tests/helpers/fakeStripe.js
'use strict';
//
// STRIPE SIMULADO para los tests (nunca llama a api.stripe.com).
//
// Es un cliente HTTP para el SDK oficial stripe-node (opción `httpClient`): el
// SDK construye y serializa la petición REAL (la misma que mandaría a Stripe) y
// este fake responde con objetos con la forma de los tipos del SDK
// (node_modules/stripe/cjs/resources/*.d.ts). Así se prueba el conector con el
// SDK de verdad, no con un mock a mano de sus funciones.
//
// PaymentMethods de prueba (lo que devolvería Stripe.js):
//   pm_ok       → autorizado (requires_capture)
//   pm_3ds      → requiere autenticación (requires_action)
//   pm_decline  → rechazo del emisor (402 card_error, code card_declined)
//   pm_funds    → rechazo por saldo (402 card_error, code card_declined, decline_code insufficient_funds)
// Fallos de red: fake.failNext('timeout' | 'network' | 500 | 429 | 401)
// Latencia: fake.latencyMs = N

const Stripe = require('stripe');

class FakeResponse extends Stripe.HttpClientResponse {
  constructor(status, body) {
    super(status, { 'request-id': `req_fake_${Math.random().toString(36).slice(2, 10)}` });
    this._body = body;
  }
  getRawResponse() { return this._body; }
  toStream() { return null; }
  toJSON() { return Promise.resolve(this._body); }
}

// "a[b][0]=c&d=e" → { a: { b: ['c'] }, d: 'e' }
function parseForm(str) {
  const out = {};
  for (const [k, v] of new URLSearchParams(str || '')) {
    const parts = k.replace(/\]/g, '').split('[');
    let o = out;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const last = i === parts.length - 1;
      const nextIsIndex = !last && /^\d+$/.test(parts[i + 1]);
      if (last) o[p] = v;
      else { if (o[p] === undefined) o[p] = nextIsIndex ? [] : {}; o = o[p]; }
    }
  }
  return out;
}

function createFakeStripe() {
  const intents = new Map();
  const refunds = [];
  const requests = [];
  const idem = new Map();
  let seq = 0;
  let failQueue = [];

  const fake = {
    intents, refunds, requests, latencyMs: 0,
    failNext(kind, times = 1) { for (let i = 0; i < times; i++) failQueue.push(kind); },
    reset() { intents.clear(); refunds.length = 0; requests.length = 0; idem.clear(); failQueue = []; fake.latencyMs = 0; },
    // Lo que hace Stripe.js (confirmCardPayment) en el navegador: confirma el
    // PaymentIntent con la tarjeta tecleada en el campo de Stripe.
    browserConfirm(piId, pm) { const pi = intents.get(piId); if (!pi) throw new Error('pi desconocido'); confirm(pi, pm); return pi; },
    // El titular completa el 3DS (Stripe.js lo muestra en su ventana).
    complete3ds(piId, ok = true) {
      const pi = intents.get(piId);
      if (ok) { pi.status = 'requires_capture'; pi.amount_capturable = pi.amount; pi.next_action = null; charge(pi); }
      else { pi.status = 'requires_payment_method'; pi.next_action = null; pi.last_payment_error = { type: 'card_error', code: 'payment_intent_authentication_failure', message: 'auth failed' }; }
      return pi;
    },
    event(type, object, { livemode = false } = {}) {
      return { id: `evt_${++seq}`, object: 'event', type, livemode, created: Math.floor(Date.now() / 1000), data: { object: JSON.parse(JSON.stringify(object)) } };
    },
    signedRequest(event, secret) {
      const payload = JSON.stringify(event);
      const header = Stripe.webhooks.generateTestHeaderString({ payload, secret });
      return { payload, header };
    },
  };

  function charge(pi) {
    pi.latest_charge = {
      id: `ch_${pi.id.slice(3)}`, object: 'charge', amount: pi.amount, amount_captured: 0, amount_refunded: 0, captured: false,
      payment_intent: pi.id, metadata: pi.metadata,
      payment_method_details: { type: 'card', card: { brand: 'visa', last4: '4242', country: 'US', funding: 'credit' } },
    };
  }

  function cardError(pi, code, decline) {
    pi.status = 'requires_payment_method';
    pi.last_payment_error = { type: 'card_error', code, ...(decline ? { decline_code: decline } : {}), message: 'Your card was declined.' };
    return [402, { error: { type: 'card_error', code, ...(decline ? { decline_code: decline } : {}), message: 'Your card was declined.', payment_intent: pi } }];
  }

  function confirm(pi, pm) {
    pi.payment_method = pm;
    if (pm === 'pm_ok') { pi.status = 'requires_capture'; pi.amount_capturable = pi.amount; charge(pi); return null; }
    if (pm === 'pm_3ds') { pi.status = 'requires_action'; pi.next_action = { type: 'use_stripe_sdk', use_stripe_sdk: {} }; return null; }
    if (pm === 'pm_decline') return cardError(pi, 'card_declined');
    if (pm === 'pm_funds') return cardError(pi, 'card_declined', 'insufficient_funds');
    return [400, { error: { type: 'invalid_request_error', code: 'resource_missing', message: `No such PaymentMethod: '${pm}'` } }];
  }

  function newIntent(p) {
    const id = `pi_fake${++seq}`;
    const pi = {
      id, object: 'payment_intent', amount: Number(p.amount), currency: p.currency, status: 'requires_payment_method',
      capture_method: p.capture_method, amount_capturable: 0, amount_received: 0, client_secret: `${id}_secret_fake${seq}`,
      metadata: p.metadata || {}, latest_charge: null, last_payment_error: null, next_action: null, livemode: false,
    };
    intents.set(id, pi);
    return pi;
  }

  function view(pi, expand) {
    const o = JSON.parse(JSON.stringify(pi));
    if (o.latest_charge && !(expand || []).includes('latest_charge')) o.latest_charge = o.latest_charge.id;
    return o;
  }

  function route(method, path, body, query) {
    const expand = [].concat(body.expand || [], query.expand || []);
    let m;
    if (method === 'POST' && path === '/v1/payment_intents') {
      const pi = newIntent(body);
      if (body.confirm === 'true' && body.payment_method) {
        const err = confirm(pi, body.payment_method);
        if (err) return err;
      }
      return [200, view(pi, expand)];
    }
    if ((m = /^\/v1\/payment_intents\/([^/]+)$/.exec(path)) && method === 'GET') {
      const pi = intents.get(m[1]);
      return pi ? [200, view(pi, expand)] : [404, { error: { type: 'invalid_request_error', code: 'resource_missing', message: 'No such payment_intent' } }];
    }
    if ((m = /^\/v1\/payment_intents\/([^/]+)\/capture$/.exec(path)) && method === 'POST') {
      const pi = intents.get(m[1]);
      if (!pi) return [404, { error: { type: 'invalid_request_error', code: 'resource_missing', message: 'No such payment_intent' } }];
      if (pi.status !== 'requires_capture') return [400, { error: { type: 'invalid_request_error', code: 'payment_intent_unexpected_state', message: `This PaymentIntent could not be captured because it has a status of ${pi.status}.` } }];
      const amt = body.amount_to_capture !== undefined ? Number(body.amount_to_capture) : pi.amount_capturable;
      if (amt > pi.amount_capturable) return [400, { error: { type: 'invalid_request_error', code: 'amount_too_large', message: 'too large' } }];
      pi.status = 'succeeded'; pi.amount_received = amt; pi.amount_capturable = 0;
      pi.latest_charge.amount_captured = amt; pi.latest_charge.captured = true;
      return [200, view(pi, expand)];
    }
    if ((m = /^\/v1\/payment_intents\/([^/]+)\/cancel$/.exec(path)) && method === 'POST') {
      const pi = intents.get(m[1]);
      if (!pi) return [404, { error: { type: 'invalid_request_error', code: 'resource_missing', message: 'No such payment_intent' } }];
      if (pi.status === 'succeeded' || pi.status === 'canceled') return [400, { error: { type: 'invalid_request_error', code: 'payment_intent_unexpected_state', message: `status ${pi.status}` } }];
      pi.status = 'canceled'; pi.amount_capturable = 0;
      return [200, view(pi, expand)];
    }
    if (method === 'POST' && path === '/v1/refunds') {
      const pi = intents.get(body.payment_intent);
      if (!pi) return [404, { error: { type: 'invalid_request_error', code: 'resource_missing', message: 'No such payment_intent' } }];
      const ch = pi.latest_charge;
      if (!ch || !ch.captured) return [400, { error: { type: 'invalid_request_error', code: 'charge_not_refundable', message: 'not captured' } }];
      const left = ch.amount_captured - ch.amount_refunded;
      const amt = body.amount !== undefined ? Number(body.amount) : left;
      if (amt > left || amt <= 0) return [400, { error: { type: 'invalid_request_error', code: 'charge_already_refunded', message: 'too much' } }];
      ch.amount_refunded += amt;
      const r = { id: `re_${++seq}`, object: 'refund', amount: amt, status: 'succeeded', payment_intent: pi.id, charge: ch.id };
      refunds.push(r);
      return [200, r];
    }
    return [404, { error: { type: 'invalid_request_error', message: `ruta no simulada ${method} ${path}` } }];
  }

  class FakeHttpClient extends Stripe.HttpClient {
    getClientName() { return 'monetiser-test-fake'; }
    async makeRequest(host, port, fullPath, method, headers, requestData) {
      const [path, qs] = String(fullPath).split('?');
      const body = parseForm(requestData);
      const query = parseForm(qs || '');
      requests.push({ host, method, path, headers, body, query, raw: requestData });
      if (fake.latencyMs) await new Promise((r) => setTimeout(r, fake.latencyMs));
      const fail = failQueue.shift();
      if (fail === 'timeout') throw Stripe.HttpClient.makeTimeoutError();
      if (fail === 'network') { const e = new Error('socket hang up'); e.code = 'ECONNRESET'; throw e; }
      if (typeof fail === 'number') {
        const type = fail === 429 ? 'invalid_request_error' : (fail === 401 ? 'invalid_request_error' : 'api_error');
        return new FakeResponse(fail, { error: { type, message: `fake ${fail}`, ...(fail === 429 ? { code: 'rate_limit' } : {}) } });
      }
      const key = headers['Idempotency-Key'];
      if (key && idem.has(key)) return new FakeResponse(...idem.get(key));
      const resp = route(method, path, body, query);
      if (key) idem.set(key, resp);
      return new FakeResponse(...resp);
    }
  }

  fake.httpClient = new FakeHttpClient();
  return fake;
}

module.exports = { createFakeStripe, parseForm };
