// tests/integration/insightsRoutes.test.js
'use strict';
// Endpoints de insights (5 nov 2026, F2): alcance de merchants en /admin y del
// comercio de la sesión en el portal.
process.env.BACKOFFICE_JWT_SECRET = 'test_bo_insights';
process.env.PORTAL_JWT_SECRET = 'test_portal_insights';

const express = require('express');
const request = require('supertest');
jest.mock('../../src/models/TraceLog', () => ({ TraceLog: null, isEnabled: false }));
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../src/models/BackofficeUser', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/MerchantUser', () => require('../helpers/memoryModel')());
jest.mock('../../src/services/insightsService', () => ({ compute: jest.fn(async (p) => ({ echo: p })) }));
const insights = require('../../src/services/insightsService');
const { backofficeToken, portalToken } = require('../helpers/sessionUsers');

const app = express();
app.use(express.json());
app.use('/backoffice', require('../../src/routes/backofficeRoutes'));
app.use('/portal', require('../../src/routes/portalRoutes'));
const bo = (scope, role = 'operator') => `Bearer ${backofficeToken({ userId: 'u-' + role + scope.join(), email: 'x@x.test', role, merchantScope: scope })}`;

beforeEach(() => insights.compute.mockClear());

test('/admin superadmin: todos o un merchant', async () => {
  const all = await request(app).get('/backoffice/insights?days=7').set('Authorization', bo(['all'], 'superadmin'));
  expect(all.status).toBe(200);
  expect(insights.compute).toHaveBeenLastCalledWith({ merchantId: null, days: '7', livemode: undefined });
  await request(app).get('/backoffice/insights?merchantId=mB').set('Authorization', bo(['all'], 'superadmin'));
  expect(insights.compute.mock.calls[1][0].merchantId).toBe('mB');
});

test('/admin con alcance limitado: solo sus merchants; otro → 403', async () => {
  const own = await request(app).get('/backoffice/insights').set('Authorization', bo(['mA']));
  expect(own.status).toBe(200);
  expect(insights.compute.mock.calls[0][0].merchantId).toEqual(['mA']);
  const other = await request(app).get('/backoffice/insights?merchantId=mB').set('Authorization', bo(['mA']));
  expect(other.status).toBe(403);
});

test('portal: siempre el merchant de la sesión; usuario de un nodo → 403', async () => {
  const t = portalToken({ userId: 'pu1', merchantId: 'mA', email: 'a@a.test', role: 'merchant_admin' });
  const res = await request(app).get('/portal/insights?merchantId=mB&days=30').set('Authorization', `Bearer ${t}`);
  expect(res.status).toBe(200);
  expect(insights.compute).toHaveBeenLastCalledWith({ merchantId: 'mA', days: '30' });
  const tn = portalToken({ userId: 'pu2', merchantId: 'mA', email: 'n@a.test', role: 'merchant_admin', hierarchyNodeId: 'node1' });
  expect((await request(app).get('/portal/insights').set('Authorization', `Bearer ${tn}`)).status).toBe(403);
});
