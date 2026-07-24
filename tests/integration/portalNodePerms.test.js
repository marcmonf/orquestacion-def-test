// tests/integration/portalNodePerms.test.js
'use strict';
//
// Permisos por nodo (M6 Fase 4): asignación de un usuario a un nodo de jerarquía
// y scoping por subárbol. Un usuario asignado a un nodo solo ve/gestiona ese nodo
// y sus descendientes; fuera de ahí no existe (404) ni puede crear/mover (403).
//
process.env.PORTAL_JWT_SECRET = 'test_portal_secret';

const express = require('express');
const request = require('supertest');

jest.mock('../../src/models/HierarchyNode', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/MerchantUser', () => require('../helpers/memoryModel')());

const HierarchyNode = require('../../src/models/HierarchyNode');
const MerchantUser  = require('../../src/models/MerchantUser');
const { signPortalToken } = require('../../src/middleware/portalAuth');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/portal/hierarchy', require('../../src/routes/portalHierarchyRoutes'));
  app.use('/portal', require('../../src/routes/portalRoutes'));
  return app;
}

function adminToken(merchantId, hierarchyNodeId = null) {
  return signPortalToken({ userId: `admin-${merchantId}`, merchantId, email: `admin@${merchantId}.com`, role: 'merchant_admin', mustChangePassword: false, hierarchyNodeId });
}
function opToken(merchantId, hierarchyNodeId = null) {
  return signPortalToken({ userId: `op-${merchantId}`, merchantId, email: `op@${merchantId}.com`, role: 'merchant_operator', mustChangePassword: false, hierarchyNodeId });
}
function createNode(app, tok, body) {
  return request(app).post('/portal/hierarchy').set('Authorization', `Bearer ${tok}`).send(body);
}

describe('Portal — permisos por nodo (Fase 4)', () => {
  let app, G, R1, R2, S1, S2;
  beforeAll(() => { app = buildApp(); });
  beforeEach(async () => {
    HierarchyNode.__reset(); MerchantUser.__reset();
    const admin = adminToken('merch-A');
    G  = (await createNode(app, admin, { nodeType: 'globalGroup', name: 'G' })).body.node;
    R1 = (await createNode(app, admin, { nodeType: 'group', name: 'R1', parentId: G._id })).body.node;
    R2 = (await createNode(app, admin, { nodeType: 'group', name: 'R2', parentId: G._id })).body.node;
    S1 = (await createNode(app, admin, { nodeType: 'store', name: 'S1', parentId: R1._id })).body.node;
    S2 = (await createNode(app, admin, { nodeType: 'store', name: 'S2', parentId: R2._id })).body.node;
  });

  // ── Asignación ──────────────────────────────────────────────────────────────
  test('un admin asigna un usuario a un nodo del propio merchant', async () => {
    const u = await MerchantUser.create({ merchantId: 'merch-A', email: 'u@a.com', passwordHash: 'x', name: 'U', role: 'merchant_operator', active: true, mustChangePassword: false });
    const res = await request(app).patch(`/portal/users/${u._id}`)
      .set('Authorization', `Bearer ${adminToken('merch-A')}`).send({ hierarchyNodeId: R1._id });
    expect(res.status).toBe(200);
    expect(res.body.user.hierarchyNodeId).toBe(R1._id);
  });

  test('400 — no se puede asignar a un nodo de otro merchant', async () => {
    const bNode = (await createNode(app, adminToken('merch-B'), { nodeType: 'globalGroup', name: 'Bg' })).body.node;
    const u = await MerchantUser.create({ merchantId: 'merch-A', email: 'u2@a.com', passwordHash: 'x', name: 'U2', role: 'merchant_operator', active: true, mustChangePassword: false });
    const res = await request(app).patch(`/portal/users/${u._id}`)
      .set('Authorization', `Bearer ${adminToken('merch-A')}`).send({ hierarchyNodeId: bNode._id });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_hierarchy_node');
  });

  test('null desasigna el nodo', async () => {
    const u = await MerchantUser.create({ merchantId: 'merch-A', email: 'u3@a.com', passwordHash: 'x', name: 'U3', role: 'merchant_operator', active: true, mustChangePassword: false, hierarchyNodeId: R1._id });
    const res = await request(app).patch(`/portal/users/${u._id}`)
      .set('Authorization', `Bearer ${adminToken('merch-A')}`).send({ hierarchyNodeId: null });
    expect(res.status).toBe(200);
    expect(res.body.user.hierarchyNodeId).toBeNull();
  });

  // ── Scoping de lectura ────────────────────────────────────────────────────────
  test('un usuario asignado a R1 solo ve su subárbol (R1 + S1)', async () => {
    const res = await request(app).get('/portal/hierarchy').set('Authorization', `Bearer ${opToken('merch-A', R1._id)}`);
    expect(res.status).toBe(200);
    const names = res.body.nodes.map(n => n.name).sort();
    expect(names).toEqual(['R1', 'S1']);
  });

  test('un admin SIN nodo asignado ve todo el merchant', async () => {
    const res = await request(app).get('/portal/hierarchy').set('Authorization', `Bearer ${adminToken('merch-A')}`);
    expect(res.body.nodes.length).toBe(5);
  });

  // ── Scoping de escritura ───────────────────────────────────────────────────────
  test('admin restringido a R1 puede crear dentro de su subárbol', async () => {
    const res = await createNode(app, adminToken('merch-A', R1._id), { nodeType: 'store', name: 'S1b', parentId: R1._id });
    expect(res.status).toBe(201);
  });

  test('403 — admin restringido a R1 NO puede crear bajo R2 (fuera de su subárbol)', async () => {
    const res = await createNode(app, adminToken('merch-A', R1._id), { nodeType: 'store', name: 'X', parentId: R2._id });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('outside_your_scope');
  });

  test('403 — admin restringido no puede crear una raíz (sin padre)', async () => {
    const res = await createNode(app, adminToken('merch-A', R1._id), { nodeType: 'globalGroup', name: 'X' });
    expect(res.status).toBe(403);
  });

  test('404 — admin restringido a R1 no puede editar S2 (fuera de su subárbol)', async () => {
    const res = await request(app).patch(`/portal/hierarchy/${S2._id}`)
      .set('Authorization', `Bearer ${adminToken('merch-A', R1._id)}`).send({ name: 'cambiado' });
    expect(res.status).toBe(404);
  });

  test('200 — admin restringido a R1 sí puede editar S1 (dentro)', async () => {
    const res = await request(app).patch(`/portal/hierarchy/${S1._id}`)
      .set('Authorization', `Bearer ${adminToken('merch-A', R1._id)}`).send({ name: 'S1 renombrada' });
    expect(res.status).toBe(200);
    expect(res.body.node.name).toBe('S1 renombrada');
  });

  test('404 — admin restringido a R1 no puede borrar S2 (fuera)', async () => {
    const res = await request(app).delete(`/portal/hierarchy/${S2._id}`).set('Authorization', `Bearer ${adminToken('merch-A', R1._id)}`);
    expect(res.status).toBe(404);
  });
});
