// tests/integration/stripeCheckout.test.js
'use strict';
//
// F1 Stripe (sesión 5 nov 2026) de punta a punta en HTTP, con el SDK oficial
// stripe-node y Stripe SIMULADO (tests/helpers/fakeStripe.js):
//   /admin guarda la cuenta Stripe de pruebas del comercio (cifrada) → preset de
//   routing de demostración → la sesión v1 se enruta (EUR+ES → Paylands; resto
//   → Stripe; failover pre-captura con el circuito de Paylands abierto) → el
//   iFrame pinta Stripe Elements → /stripe/session → Stripe.js confirma →
//   /stripe/complete consulta Stripe → misma máquina de estados → mismo webhook
//   saliente; webhook entrante de Stripe firmado por merchant.

process.env.BACKOFFICE_JWT_SECRET = 'test_backoffice_secret_stripe';
process.env.CREDENTIALS_ENCRYPTION_KEY = 'd'.repeat(64);
process.env.HPP_SIGNING_SECRET = 'e'.repeat(64);
process.env.FEATURE_STRIPE = 'true';
// Divisas aceptadas por la plataforma (Render: SUPPORTED_CURRENCIES). Para la demo
// con Stripe hace falta añadir USD/GBP; por defecto solo EUR.
process.env.SUPPORTED_CURRENCIES = 'EUR,USD,GBP';

const express = require('express');
const request = require('supertest');
const crypto = require('crypto');

jest.mock('../../src/models/TraceLog', () => ({ TraceLog: null, isEnabled: false }));
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../src/logs/auditLogger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../../src/models/BackofficeUser', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/Merchant', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/MerchantRules', () => require('../helpers/memoryModel')({ unique: [['merchantId']] }));
jest.mock('../../src/models/RuleAudit', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/MerchantAcquirer', () => require('../helpers/memoryModel')({ unique: [['merchantId', 'acquirerCode']] }));
jest.mock('../../src/models/MerchantApiKey', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/WebhookEvent', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/Transaction', () => require('../helpers/memoryModel')({ unique: [['paymentId'], ['merchantId', 'idempotencyKey']] }));
jest.mock('../../src/services/webhookDispatcher', () => ({ enqueue: jest.fn().mockResolvedValue(true) }));
jest.mock('../../src/services/pciProxyService', () => ({
  issueTokenizationToken: jest.fn().mockResolvedValue('sess'),
  getTokenizationResults: jest.fn().mockResolvedValue({ token: 'CARD-UUID', pan: '401881******0036' }),
}));

const Merchant = require('../../src/models/Merchant');
const MerchantRules = require('../../src/models/MerchantRules');
const MerchantAcquirer = require('../../src/models/MerchantAcquirer');
const MerchantApiKey = require('../../src/models/MerchantApiKey');
const Transaction = require('../../src/models/Transaction');
const WebhookEvent = require('../../src/models/WebhookEvent');
const dispatcher = require('../../src/services/webhookDispatcher');
const health = require('../../src/services/connectorHealth');
const registry = require('../../src/services/connectorRegistry');
const stripeProvider = require('../../src/connectors/stripe');
const { createFakeStripe } = require('../helpers/fakeStripe');
const { backofficeToken } = require('../helpers/sessionUsers');

const fake = createFakeStripe();
stripeProvider.extensions._testing.setHttpClient(fake.httpClient);

const SECRET = 'ms_' + 'f'.repeat(64);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const superadmin = () => `Bearer ${backofficeToken({ userId: 'u1', email: 'boss@x.test', role: 'superadmin', merchantScope: ['all'] })}`;
const STRIPE_CREDS = { secretKey: 'sk_test_demo123', publishableKey: 'pk_test_demo123', webhookSecret: 'whsec_demo123' };
const M = 'merch-S';

function buildApp() {
  const app = express();
  app.use('/webhooks/stripe', express.raw({ type: '*/*', limit: '1mb' }), require('../../src/routes/stripeWebhook'));
  app.use(express.json());
  app.use('/backoffice', require('../../src/routes/backofficeRoutes'));
  app.use('/v1', require('../../src/routes/v1'));
  app.use('/:merchantId/proxy-pci', require('../../src/routes/proxyPciRoutes'));
  app.use('/:merchantId/stripe', require('../../src/routes/stripeCheckoutRoutes'));
  app.use('/:merchantId/iframe', require('../../src/routes/iframe'));
  app.use('/hpp', require('../../src/routes/hpp'));
  return app;
}

let app;
let ipSeq = 0;
beforeEach(async () => {
  for (const X of [Merchant, MerchantRules, MerchantAcquirer, MerchantApiKey, Transaction, WebhookEvent]) X.__reset();
  require('../../src/middleware/hmacAuth')._clearStatusCache();
  health._reset();
  fake.reset();
  dispatcher.enqueue.mockClear();
  await Merchant.create({ merchantId: M, status: 'active', webhookUrl: 'https://shop.invalid/hook' });
  await Merchant.create({ merchantId: 'merch-other', status: 'active' });
  await MerchantApiKey.create({ merchantId: M, keyId: 'mk_s', secretHash: sha(SECRET), active: true });
  app = buildApp();
});

// IP distinta por petición: el límite del checkout es por IP.
const fromIp = (r) => r.set('X-Forwarded-For', `10.9.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`);

async function configureStripe() {
  const res = await request(app).put(`/backoffice/merchants/${M}/connector-accounts/stripe/credentials`)
    .set('Authorization', superadmin()).send({ mode: 'test', credentials: STRIPE_CREDS });
  expect(res.status).toBe(200);
  return res;
}
async function demoPreset() {
  const res = await request(app).post(`/backoffice/routing/${M}/demo-preset`).set('Authorization', superadmin()).send({});
  expect(res.status).toBe(200);
  return res;
}
async function session(body) {
  const res = await request(app).post('/v1/checkout-sessions').set('Authorization', `Bearer ${SECRET}`)
    .set('Idempotency-Key', `k-${Math.random()}`).send({ amount: 2500, currency: 'EUR', reference: 'ORD-1', ...body });
  expect(res.status).toBe(201);
  return Transaction.findOne({ paymentId: res.body.paymentId || res.body.id }).lean();
}

describe('Cuenta Stripe del comercio en /admin', () => {
  test('guarda cifrado, enmascarado; rechaza claves live y prefijos erróneos', async () => {
    const res = await configureStripe();
    expect(res.body.account.connector).toBe('stripe');
    expect(res.body.account.credentials.test.fields).toEqual({ secretKey: '••••o123', publishableKey: 'pk_test_demo123', webhookSecret: '••••o123' });
    const doc = await MerchantAcquirer.findOne({ merchantId: M, acquirerCode: 'stripe' }).lean();
    expect(JSON.stringify(doc)).not.toContain('sk_test_demo123');
    expect(JSON.stringify(doc)).not.toContain('whsec_demo123');
    const live = await request(app).put(`/backoffice/merchants/${M}/connector-accounts/stripe/credentials`)
      .set('Authorization', superadmin()).send({ mode: 'test', credentials: { ...STRIPE_CREDS, secretKey: 'sk_live_x1' } });
    expect(live.status).toBe(400);
    const liveMode = await request(app).put(`/backoffice/merchants/${M}/connector-accounts/stripe/credentials`)
      .set('Authorization', superadmin()).send({ mode: 'live', credentials: STRIPE_CREDS });
    expect(liveMode.status).toBe(400);
    const conns = await request(app).get('/backoffice/connectors').set('Authorization', superadmin());
    const st = conns.body.connectors.find((c) => c.id === 'stripe');
    expect(st.checkoutAvailable).toBe(true);
    expect(st.capabilities.perAccountCredentials).toBe(true);
  });
});

describe('Routing de demostración', () => {
  test('EUR+ES → Paylands; EUR+FR → Stripe; USD → Stripe; Paylands caído → Stripe antes de pedir la tarjeta', async () => {
    await configureStripe();
    const p = await demoPreset();
    expect(p.body.policy.rules[0]).toMatchObject({ when: { currency: { in: ['EUR'] }, country: { in: ['ES'] } }, action: { route: 'payNoPain' } });
    expect(p.body.policy.defaultConnector).toBe('stripe');

    expect((await session({ country: 'ES' })).routing).toMatchObject({ connector: 'payNoPain', fieldsProvider: 'paylands_proxyfields', reason: 'rule' });
    expect((await session({ country: 'FR' })).routing).toMatchObject({ connector: 'stripe', fieldsProvider: 'stripe_elements', reason: 'default' });
    expect((await session({ currency: 'USD', country: 'US' })).routing).toMatchObject({ connector: 'stripe' });

    for (let i = 0; i < 5; i++) health.recordFailure('payNoPain', 'processor_unavailable');
    const failover = await session({ country: 'ES' });
    expect(failover.routing).toMatchObject({ connector: 'stripe', reason: 'failover_pre_card' });
  });

  test('sin cuenta Stripe del comercio: todo a Paylands (el preset no deja sin cobrar)', async () => {
    await demoPreset();
    const tx = await session({ country: 'FR' });
    expect(tx.routing.connector).toBe('payNoPain');
    expect(tx.routing.reason).toBe('failover_pre_card');
  });

  test('simulador de /admin explica la decisión', async () => {
    await configureStripe(); await demoPreset();
    const r = await request(app).post(`/backoffice/routing/${M}/simulate`).set('Authorization', superadmin()).send({ amount: 1000, currency: 'GBP' });
    expect(r.body.decision.connector).toBe('stripe');
  });
});

describe('Checkout con Stripe Elements', () => {
  async function stripeTx() {
    await configureStripe(); await demoPreset();
    return session({ country: 'FR' });
  }

  test('el iFrame pinta el proveedor stripe_elements con su CSP (ruta absoluta del módulo)', async () => {
    const tx = await stripeTx();
    const v1 = await request(app).get(`/v1/checkout-sessions/${tx.paymentId}`).set('Authorization', `Bearer ${SECRET}`);
    const hpp = await fromIp(request(app).get(new URL(v1.body.url, 'http://x').pathname));
    expect(hpp.status).toBe(302);
    expect(hpp.headers.location).toMatch(new RegExp(`^/${M}/iframe\\?paymentId=`));
    // El GET del iFrame guarda con tx.save() (el modelo en memoria no lo tiene):
    // se comprueba con las mismas funciones que usa la ruta.
    const iframe = require('../../src/routes/iframe')._test;
    const cp = require('../../src/utils/checkoutProviders');
    const provider = iframe.fieldsProviderFor(tx);
    expect(provider.id).toBe('stripe_elements');
    const csp = cp.buildCsp(provider);
    expect(csp).toContain("script-src 'self' 'unsafe-inline' https://js.stripe.com;");
    expect(csp).toContain('https://hooks.stripe.com');
    expect(csp).not.toContain('paynopain');
    const html = iframe.injectRuntime('<html><head></head><body></body></html>', {}, { paymentId: tx.paymentId, merchantId: M, fieldsProvider: provider, paymentMethods: iframe.paymentMethodsFor(tx) });
    expect(html).toContain('"fieldsProvider":"stripe_elements"');
    expect(html).toContain('"providerScript":"/checkout/providers/stripe_elements.js"');
    expect(html).toContain('https://js.stripe.com/endive/stripe.js');
  });

  test('session → confirmación en el navegador → complete: autorizado, metadatos de tarjeta y webhook saliente con connectorUsed stripe', async () => {
    const tx = await stripeTx();
    const s = await fromIp(request(app).post(`/${M}/stripe/session`).send({ paymentId: tx.paymentId }));
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ success: true, publishableKey: 'pk_test_demo123' });
    expect(s.body.clientSecret).toMatch(/_secret_/);
    expect(JSON.stringify(s.body)).not.toContain('sk_test');
    const linked = await Transaction.findOne({ paymentId: tx.paymentId }).lean();
    expect(linked).toMatchObject({ processor: 'stripe', status: 'hosted_pending' });
    expect(linked.processorReference).toMatch(/^pi_/);
    // PaymentIntent con captura manual = equivalente al DEFERRED de Paylands.
    expect(fake.intents.get(linked.processorReference).capture_method).toBe('manual');

    // Recargar el iFrame no crea otro PaymentIntent.
    const s2 = await fromIp(request(app).post(`/${M}/stripe/session`).send({ paymentId: tx.paymentId }));
    expect(s2.body.clientSecret).toBe(s.body.clientSecret);
    expect(fake.intents.size).toBe(1);

    fake.browserConfirm(linked.processorReference, 'pm_ok'); // Stripe.js confirmCardPayment
    const c = await fromIp(request(app).post(`/${M}/stripe/complete`).send({ paymentId: tx.paymentId }));
    expect(c.body).toMatchObject({ success: true, status: 'authorized' });
    expect(c.body.resultUrl).toMatch(/^\/checkout\/result\/.+outcome=ok/);
    const after = await Transaction.findOne({ paymentId: tx.paymentId }).lean();
    expect(after).toMatchObject({ status: 'authorized', cardBrand: 'visa', cardLast4: '4242', issuerCountry: 'US', cardType: 'credit' });
    expect(dispatcher.enqueue).toHaveBeenCalledTimes(1);
    const payload = dispatcher.enqueue.mock.calls[0][0].payload;
    expect(payload).toMatchObject({ event: 'payment.updated', version: 'v1', data: { paymentId: tx.paymentId, status: 'authorized', connectorUsed: 'stripe', livemode: false, amount: 2500, currency: 'EUR', merchantReference: 'ORD-1' } });
    expect(Object.keys(payload.data).sort()).toEqual(['amount', 'connectorUsed', 'currency', 'livemode', 'merchantId', 'merchantReference', 'paymentId', 'status', 'timestamp']);

    // El webhook de Stripe llega después: mismo estado → sin cambio, sin segundo webhook saliente.
    const pi = fake.intents.get(linked.processorReference);
    const { payload: raw, header } = fake.signedRequest(fake.event('payment_intent.amount_capturable_updated', pi), STRIPE_CREDS.webhookSecret);
    const w = await request(app).post(`/webhooks/stripe/${M}`).set('Content-Type', 'application/json').set('Stripe-Signature', header).send(raw);
    expect(w.status).toBe(200);
    expect(w.body).toMatchObject({ received: true, status: 'authorized', changed: false });
    expect(dispatcher.enqueue).toHaveBeenCalledTimes(1);
  });

  test('rechazo del emisor: complete → declined y página de resultado ko', async () => {
    const tx = await stripeTx();
    await fromIp(request(app).post(`/${M}/stripe/session`).send({ paymentId: tx.paymentId }));
    const ref = (await Transaction.findOne({ paymentId: tx.paymentId }).lean()).processorReference;
    fake.browserConfirm(ref, 'pm_decline');
    const c = await fromIp(request(app).post(`/${M}/stripe/complete`).send({ paymentId: tx.paymentId }));
    expect(c.body).toMatchObject({ success: false, status: 'declined' });
    expect(c.body.resultUrl).toMatch(/outcome=ko/);
  });

  test('3DS: requires_action → el titular autentica → authorized', async () => {
    const tx = await stripeTx();
    await fromIp(request(app).post(`/${M}/stripe/session`).send({ paymentId: tx.paymentId }));
    const ref = (await Transaction.findOne({ paymentId: tx.paymentId }).lean()).processorReference;
    fake.browserConfirm(ref, 'pm_3ds');
    fake.complete3ds(ref, true);
    const c = await fromIp(request(app).post(`/${M}/stripe/complete`).send({ paymentId: tx.paymentId }));
    expect(c.body.status).toBe('authorized');
  });

  test('sin confirmar en el navegador: complete no cierra el pago (se puede reintentar)', async () => {
    const tx = await stripeTx();
    await fromIp(request(app).post(`/${M}/stripe/session`).send({ paymentId: tx.paymentId }));
    const c = await fromIp(request(app).post(`/${M}/stripe/complete`).send({ paymentId: tx.paymentId }));
    expect(c.body).toMatchObject({ success: false, retry: true });
    expect((await Transaction.findOne({ paymentId: tx.paymentId }).lean()).status).toBe('hosted_pending');
  });

  test('Stripe sin respuesta en complete: no se inventa el resultado (pendiente del webhook)', async () => {
    const tx = await stripeTx();
    await fromIp(request(app).post(`/${M}/stripe/session`).send({ paymentId: tx.paymentId }));
    fake.failNext('timeout');
    const c = await fromIp(request(app).post(`/${M}/stripe/complete`).send({ paymentId: tx.paymentId }));
    expect(c.body).toMatchObject({ pending: true });
    expect((await Transaction.findOne({ paymentId: tx.paymentId }).lean()).status).toBe('hosted_pending');
  });

  test('cada backend de campos se niega a cobrar un pago enrutado al otro', async () => {
    await configureStripe(); await demoPreset();
    const stripeTxDoc = await session({ country: 'FR' });
    const paylandsTx = await session({ country: 'ES' });
    const a = await fromIp(request(app).post(`/${M}/proxy-pci/charge`).send({ paymentId: stripeTxDoc.paymentId }));
    expect(a.status).toBe(409);
    const b = await fromIp(request(app).post(`/${M}/stripe/session`).send({ paymentId: paylandsTx.paymentId }));
    expect(b.status).toBe(409);
    expect(b.body.message).toMatch(/wrong_fields_provider/);
    // Otro merchant no puede abrir la sesión de este pago.
    const c = await fromIp(request(app).post('/merch-other/stripe/session').send({ paymentId: stripeTxDoc.paymentId }));
    expect(c.status).toBe(404);
  });
});

describe('Webhook entrante de Stripe (por merchant)', () => {
  async function linkedTx() {
    await configureStripe(); await demoPreset();
    const tx = await session({ country: 'FR' });
    await fromIp(request(app).post(`/${M}/stripe/session`).send({ paymentId: tx.paymentId }));
    return Transaction.findOne({ paymentId: tx.paymentId }).lean();
  }
  const send = (mid, raw, header) => request(app).post(`/webhooks/stripe/${mid}`).set('Content-Type', 'application/json').set('Stripe-Signature', header).send(raw);

  test('firma válida → autoriza y webhook saliente; firma manipulada → 401; otro merchant → 409', async () => {
    const tx = await linkedTx();
    const pi = fake.browserConfirm(tx.processorReference, 'pm_ok');
    const ev = fake.event('payment_intent.amount_capturable_updated', pi);
    const { payload, header } = fake.signedRequest(ev, STRIPE_CREDS.webhookSecret);
    expect((await send(M, payload.replace('2500', '1'), header)).status).toBe(401);
    expect((await send('merch-other', payload, header)).status).toBe(409);
    const ok = await send(M, payload, header);
    expect(ok.body).toMatchObject({ received: true, status: 'authorized', changed: true });
    expect(dispatcher.enqueue).toHaveBeenCalledTimes(1);
    // Duplicado: idempotente.
    const dup = await send(M, payload, header);
    expect(dup.body.changed).toBe(false);
    expect(dispatcher.enqueue).toHaveBeenCalledTimes(1);
    const audit = await WebhookEvent.find({ paymentId: tx.paymentId }).lean();
    expect(audit.length).toBe(2);
    expect(JSON.stringify(audit)).not.toContain('client_secret');
  });

  test('desordenados: un payment_failed tardío no hace retroceder un pago autorizado', async () => {
    const tx = await linkedTx();
    const pi = fake.browserConfirm(tx.processorReference, 'pm_ok');
    const ok = fake.signedRequest(fake.event('payment_intent.amount_capturable_updated', pi), STRIPE_CREDS.webhookSecret);
    await send(M, ok.payload, ok.header);
    const late = fake.signedRequest(fake.event('payment_intent.payment_failed', { ...pi, status: 'requires_payment_method' }), STRIPE_CREDS.webhookSecret);
    const r = await send(M, late.payload, late.header);
    expect(r.body.changed).toBe(false);
    expect((await Transaction.findOne({ paymentId: tx.paymentId }).lean()).status).toBe('authorized');
  });

  test('evento de modo real o no relevante → 200 ignorado', async () => {
    const tx = await linkedTx();
    const pi = fake.intents.get(tx.processorReference);
    const live = fake.signedRequest(fake.event('payment_intent.amount_capturable_updated', pi, { livemode: true }), STRIPE_CREDS.webhookSecret);
    expect((await send(M, live.payload, live.header)).body).toMatchObject({ ignored: true });
    const other = fake.signedRequest(fake.event('customer.created', { id: 'cus_1', object: 'customer' }), STRIPE_CREDS.webhookSecret);
    expect((await send(M, other.payload, other.header)).body).toMatchObject({ ignored: true });
  });
});
