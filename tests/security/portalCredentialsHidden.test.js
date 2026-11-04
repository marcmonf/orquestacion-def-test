// tests/security/portalCredentialsHidden.test.js
'use strict';
// Revisión 5 nov 2026, L3: el portal del comercio no ve ni borra las
// credenciales de PSP (cifradas) que Monetiser guarda en la ficha de adquirente.

process.env.PORTAL_JWT_SECRET = 'portal_secret_review';
const express = require('express');
const request = require('supertest');

jest.mock('../../src/models/TraceLog', () => ({ TraceLog: null, isEnabled: false }));
['Acquirer', 'MerchantAcquirer', 'MerchantRoutingRule', 'InterchangeRate', 'Transaction', 'Merchant', 'MerchantContract', 'PricingPlan']
  .forEach((m) => jest.mock(`../../src/models/${m}`, () => require('../helpers/memoryModel')()));
jest.mock('../../src/models/MerchantUser', () => require('../helpers/memoryModel')());

const MerchantAcquirer = require('../../src/models/MerchantAcquirer');
const { portalToken } = require('../helpers/sessionUsers');

test('GET/PUT/DELETE /portal/acquirers no exponen ni permiten retirar la cuenta con credenciales', async () => {
  await MerchantAcquirer.create({ merchantId: 'M', acquirerCode: 'paylands', credentialsEnc: { test: 'v1:aa:bb:cc', live: null }, credentialsMeta: { test: { updatedBy: 'boss@monetiser' } } });
  const app = express(); app.use(express.json()); app.use('/portal', require('../../src/routes/portalRoutes'));
  const auth = { Authorization: `Bearer ${portalToken({ userId: 'pu1', merchantId: 'M', email: 'a@m', role: 'merchant_admin' })}` };
  const g = await request(app).get('/portal/acquirers').set(auth);
  expect(g.status).toBe(200);
  expect(JSON.stringify(g.body)).not.toMatch(/credentialsEnc|credentialsMeta|boss@monetiser/);
  expect(g.body.acquirers[0].pspCredentialsConfigured).toBe(true);
  expect((await request(app).delete('/portal/acquirers/paylands').set(auth)).status).toBe(409);
  expect((await request(app).put('/portal/acquirers/paylands').set(auth).send({ active: false })).status).toBe(409);
  const ok = await request(app).put('/portal/acquirers/paylands').set(auth).send({ markupBps: 10 });
  expect(ok.status).toBe(200);
  expect(JSON.stringify(ok.body)).not.toMatch(/credentialsEnc/);
  expect(MerchantAcquirer.__store[0].credentialsEnc.test).toBe('v1:aa:bb:cc');
});
