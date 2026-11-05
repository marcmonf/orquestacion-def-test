// tests/contract/stripe.contract.test.js
'use strict';
// El conector Stripe pasa la MISMA suite de contrato que Paylands, con el SDK
// oficial stripe-node real y una red simulada (tests/helpers/fakeStripe.js):
// nunca llama a api.stripe.com.

jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn() }));

const provider = require('../../src/connectors/stripe');
const { runConnectorContract } = require('./connectorContract');
const { createFakeStripe } = require('../helpers/fakeStripe');
const { checkPaymentResult } = require('../../src/connectors/contract');

const fake = createFakeStripe();
provider.extensions._testing.setHttpClient(fake.httpClient);

const ctx = { credentials: { secretKey: 'sk_test_contract', publishableKey: 'pk_test_contract', webhookSecret: 'whsec_contract' } };
const base = { paymentId: 'pay-s1', merchantId: 'm1', amount: 1000, currency: 'EUR', method: 'card' };

async function authorized(amount = 1000) {
  const r = await provider.createPayment({ ...base, paymentId: `pay-${Math.random()}`, amount, sourceToken: 'pm_ok' }, ctx);
  return r.processorReference;
}
// Entradas del ciclo de vida: la suite las lee DESPUÉS de prepare(), que les
// pone la referencia del PaymentIntent recién creado.
const L = {
  captureOk: { processorReference: null, amount: 500 },
  cancelOk: { processorReference: null },
  refundOk: { processorReference: null, amount: 200 },
  refundWithoutCapture: { processorReference: null },
};

runConnectorContract({
  provider,
  harness: {
    ctx,
    payment(kind) {
      const id = `pay-c-${kind}`;
      if (kind === 'approve') return { ...base, paymentId: id, sourceToken: 'pm_ok' };
      if (kind === 'requires_action') return { ...base, paymentId: id }; // checkout: confirma Stripe.js
      if (kind === 'decline') return { ...base, paymentId: id, sourceToken: 'pm_decline' };
      return { ...base, paymentId: id, sourceToken: 'pm_ok' };
    },
    prepare(kind) {
      if (kind === 'technical_error') fake.failNext('timeout');
    },
    lifecycle: {
      captureOk: { input: L.captureOk, prepare: async () => { L.captureOk.processorReference = await authorized(); } },
      cancelOk: { input: L.cancelOk, prepare: async () => { L.cancelOk.processorReference = await authorized(); } },
      refundOk: {
        input: L.refundOk,
        prepare: async () => { L.refundOk.processorReference = await authorized(); await provider.capture({ processorReference: L.refundOk.processorReference }, ctx); },
      },
      refundWithoutCapture: { input: L.refundWithoutCapture, prepare: async () => { L.refundWithoutCapture.processorReference = await authorized(); } },
    },
    webhook() {
      const pi = { id: 'pi_wh1', object: 'payment_intent', status: 'requires_capture', amount: 1000, amount_received: 0, metadata: { paymentId: 'pay-wh1' } };
      const ev = fake.event('payment_intent.amount_capturable_updated', pi);
      const { payload, header } = fake.signedRequest(ev, 'whsec_contract');
      return {
        ctx,
        valid: { body: ev, rawBody: payload, headers: { 'stripe-signature': header } },
        tampered: { body: ev, rawBody: payload.replace('1000', '1'), headers: { 'stripe-signature': header } },
      };
    },
    rawStatuses: ['requires_capture', 'succeeded', 'canceled', 'requires_action', 'processing', 'requires_payment_method', 'requires_confirmation'],
  },
});

describe('Stripe — detalles del conector', () => {
  test('createPayment sin tarjeta (checkout): PaymentIntent manual + client_confirm', async () => {
    fake.requests.length = 0;
    const r = await provider.createPayment({ ...base, paymentId: 'pay-d1' }, ctx);
    expect(checkPaymentResult(r)).toEqual([]);
    expect(r.status).toBe('requires_action');
    expect(r.action.type).toBe('client_confirm');
    expect(r.action.clientSecret).toMatch(/_secret_/);
    const req = fake.requests[0];
    expect(req.host).toBe('api.stripe.com');
    expect(req.path).toBe('/v1/payment_intents');
    expect(req.body).toMatchObject({ amount: '1000', currency: 'eur', capture_method: 'manual', allowed_payment_method_types: ['card'], metadata: { paymentId: 'pay-d1', merchantId: 'm1' } });
    expect(req.body.confirm).toBeUndefined();
    expect(req.headers['Idempotency-Key']).toBe('monetiser_pi_pay-d1');
    expect(req.headers.Authorization).toBe('Bearer sk_test_contract');
  });

  test('idempotencia: la misma sesión dos veces → el mismo PaymentIntent', async () => {
    const a = await provider.createPayment({ ...base, paymentId: 'pay-d2' }, ctx);
    const b = await provider.createPayment({ ...base, paymentId: 'pay-d2' }, ctx);
    expect(a.processorReference).toBe(b.processorReference);
  });

  test('sin credenciales → configuration_error (nunca llama a Stripe)', async () => {
    const n = fake.requests.length;
    const r = await provider.createPayment(base, {});
    expect(r.status).toBe('error');
    expect(r.error.code).toBe('configuration_error');
    expect(fake.requests.length).toBe(n);
  });

  test('modo live rechazado en esta fase', async () => {
    const r = await provider.createPayment(base, { ...ctx, livemode: true });
    expect(r.error.code).toBe('configuration_error');
  });

  test('captura parcial → partially_captured; captura sobre capturado → conflict', async () => {
    const ref2 = await authorized(1000);
    const c = await provider.capture({ processorReference: ref2, amount: 400 }, ctx);
    expect(c).toMatchObject({ success: true, status: 'partially_captured', capturedTotal: 400 });
    const again = await provider.capture({ processorReference: ref2, amount: 100 }, ctx);
    expect(again.success).toBe(false);
    expect(again.error.code).toBe('conflict');
  });

  test('refund total y parcial con importe acumulado', async () => {
    const ref3 = await authorized(1000);
    await provider.capture({ processorReference: ref3 }, ctx);
    const p = await provider.refund({ processorReference: ref3, amount: 300 }, ctx);
    expect(p).toMatchObject({ success: true, status: 'partially_refunded', refundedTotal: 300 });
    const p2 = await provider.refund({ processorReference: ref3, amount: 300 }, ctx);
    expect(p2).toMatchObject({ success: true, status: 'partially_refunded', refundedTotal: 600 });
    const t = await provider.refund({ processorReference: ref3 }, ctx);
    expect(t).toMatchObject({ success: true, status: 'refunded', refundedTotal: 1000 });
  });

  test('refund sin captura → conflict (sin llamar a /v1/refunds)', async () => {
    const ref4 = await authorized(1000);
    fake.requests.length = 0;
    const r = await provider.refund({ processorReference: ref4 }, ctx);
    expect(r.success).toBe(false);
    expect(r.error.code).toBe('conflict');
    expect(fake.requests.some((q) => q.path === '/v1/refunds')).toBe(false);
  });

  test('errores: timeout → timeout; red → processor_unavailable; 500 → processor_unavailable; 429 → rate_limited', async () => {
    fake.failNext('timeout');
    expect((await provider.createPayment({ ...base, paymentId: 'e1', sourceToken: 'pm_ok' }, ctx)).error.code).toBe('timeout');
    fake.failNext('network', 2); // el SDK reintenta una vez una conexión cerrada
    expect((await provider.createPayment({ ...base, paymentId: 'e2', sourceToken: 'pm_ok' }, ctx)).error.code).toBe('processor_unavailable');
    fake.failNext(500);
    expect((await provider.createPayment({ ...base, paymentId: 'e3', sourceToken: 'pm_ok' }, ctx)).error.code).toBe('processor_unavailable');
    fake.failNext(429);
    expect((await provider.createPayment({ ...base, paymentId: 'e4', sourceToken: 'pm_ok' }, ctx)).error.code).toBe('rate_limited');
  });

  test('rechazo del emisor: declined con código normalizado y referencia', async () => {
    const r = await provider.createPayment({ ...base, paymentId: 'd-funds', sourceToken: 'pm_funds' }, ctx);
    expect(r.status).toBe('declined');
    expect(r.error.code).toBe('card_declined');
    expect(r.processorReference).toMatch(/^pi_/);
  });

  test('retrieve: estado de Monetiser y metadatos de tarjeta (sin PAN)', async () => {
    const ref5 = await authorized(1000);
    const r = await provider.retrieve({ processorReference: ref5 }, ctx);
    expect(r).toMatchObject({ success: true, status: 'authorized', rawStatus: 'requires_capture', card: { cardBrand: 'visa', cardLast4: '4242', issuerCountry: 'US', cardType: 'credit' } });
  });

  test('parseWebhook: eventos → estados de Monetiser', () => {
    const pi = { id: 'pi_x', object: 'payment_intent', status: 'succeeded', amount: 1000, amount_received: 600, metadata: { paymentId: 'p' } };
    expect(provider.parseWebhook(fake.event('payment_intent.succeeded', pi)).status).toBe('partially_captured');
    expect(provider.parseWebhook(fake.event('payment_intent.payment_failed', { ...pi, status: 'requires_payment_method' })).status).toBe('declined');
    expect(provider.parseWebhook(fake.event('payment_intent.canceled', { ...pi, status: 'canceled' })).status).toBe('cancelled');
    const ch = { id: 'ch_x', object: 'charge', payment_intent: 'pi_x', amount: 1000, amount_captured: 1000, amount_refunded: 1000 };
    expect(provider.parseWebhook(fake.event('charge.refunded', ch))).toMatchObject({ processorReference: 'pi_x', status: 'refunded' });
    expect(provider.parseWebhook(fake.event('charge.refunded', { ...ch, amount_refunded: 10 })).status).toBe('partially_refunded');
    expect(provider.parseWebhook(fake.event('customer.created', { id: 'cus', object: 'customer' }))).toBeNull();
  });

  test('validateCredentials: prefijos de pruebas y solo modo test', () => {
    const v = provider.extensions.validateCredentials;
    expect(v({ secretKey: 'sk_test_abc', publishableKey: 'pk_test_abc', webhookSecret: 'whsec_abc' }, 'test')).toBeNull();
    expect(v({ secretKey: 'sk_live_abc', publishableKey: 'pk_test_abc', webhookSecret: 'whsec_abc' }, 'test')).toMatch(/sk_test_/);
    expect(v({ secretKey: 'sk_test_abc', publishableKey: 'pk_live_abc', webhookSecret: 'whsec_abc' }, 'test')).toMatch(/pk_test_/);
    expect(v({ secretKey: 'sk_test_abc', publishableKey: 'pk_test_abc', webhookSecret: 'nope' }, 'test')).toMatch(/whsec_/);
    expect(v({ secretKey: 'sk_test_abc', publishableKey: 'pk_test_abc', webhookSecret: 'whsec_abc' }, 'live')).toMatch(/PRUEBAS/);
  });
});
