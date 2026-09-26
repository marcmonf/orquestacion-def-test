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
const { portalToken } = require('../helpers/sessionUsers');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/portal/hierarchy', require('../../src/routes/portalHierarchyRoutes'));
  app.use('/portal', require('../../src/routes/portalRoutes'));
  return app;
}

// Un usuario de sesión distinto por nodo: el nodo se lee de la base de datos en
// cada petición, así que reutilizar el mismo id con otro nodo cambiaría el
// alcance de los tokens anteriores.
function adminId(merchantId, hierarchyNodeId = null) {
  return `admin-${merchantId}-${hierarchyNodeId || 'all'}`;
}
function adminToken(merchantId, hierarchyNodeId = null) {
  return portalToken({ userId: adminId(merchantId, hierarchyNodeId), merchantId, email: `admin-${hierarchyNodeId || 'all'}@${merchantId}.com`, role: 'merchant_admin', mustChangePassword: false, hierarchyNodeId });
}
function opToken(merchantId, hierarchyNodeId = null) {
  return portalToken({ userId: `op-${merchantId}-${hierarchyNodeId || 'all'}`, merchantId, email: `op-${hierarchyNodeId || 'all'}@${merchantId}.com`, role: 'merchant_operator', mustChangePassword: false, hierarchyNodeId });
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

  // ── Gestión de usuarios de un admin restringido (26 sep 2026) ────────────────
  // Antes un admin restringido a un nodo se quitaba la restricción a sí mismo
  // (PATCH { hierarchyNodeId: null }) o creaba usuarios sin nodo: la
  // restricción se saltaba en una petición.
  function mkUser(email, hierarchyNodeId = null, role = 'merchant_operator') {
    return MerchantUser.create({ merchantId: 'merch-A', email, passwordHash: 'x', name: email, role, active: true, mustChangePassword: false, hierarchyNodeId });
  }

  test('409 — un admin restringido NO puede quitarse su propia restricción', async () => {
    const tok = adminToken('merch-A', R1._id);
    const me = adminId('merch-A', R1._id);
    const res = await request(app).patch(`/portal/users/${me}`).set('Authorization', `Bearer ${tok}`).send({ hierarchyNodeId: null });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('cannot_change_own_node');
    expect(MerchantUser.__store.find(u => u._id === me).hierarchyNodeId).toBe(R1._id);
    // Tampoco moverse a otro nodo (fuera de su subárbol).
    const move = await request(app).patch(`/portal/users/${me}`).set('Authorization', `Bearer ${tok}`).send({ hierarchyNodeId: R2._id });
    expect(move.status).toBe(409);
    // Su nombre sí lo puede cambiar.
    const rename = await request(app).patch(`/portal/users/${me}`).set('Authorization', `Bearer ${tok}`).send({ name: 'Admin R1' });
    expect(rename.status).toBe(200);
  });

  test('admin restringido: los usuarios fuera de su subárbol (o sin nodo) no existen para él', async () => {
    const outside = await mkUser('fuera@a.com', R2._id);
    const unrestricted = await mkUser('todo@a.com', null);
    const inside = await mkUser('dentro@a.com', S1._id);
    const tok = adminToken('merch-A', R1._id);
    expect((await request(app).patch(`/portal/users/${outside._id}`).set('Authorization', `Bearer ${tok}`).send({ active: false })).status).toBe(404);
    expect((await request(app).patch(`/portal/users/${unrestricted._id}`).set('Authorization', `Bearer ${tok}`).send({ role: 'merchant_viewer' })).status).toBe(404);
    expect((await request(app).patch(`/portal/users/${inside._id}`).set('Authorization', `Bearer ${tok}`).send({ role: 'merchant_viewer' })).status).toBe(200);
    const list = await request(app).get('/portal/users').set('Authorization', `Bearer ${tok}`);
    const emails = list.body.users.map(u => u.email);
    expect(emails).toContain('dentro@a.com');
    expect(emails).not.toContain('fuera@a.com');
    expect(emails).not.toContain('todo@a.com');
  });

  test('403 — admin restringido no puede dejar a nadie sin restricción ni asignar fuera de su subárbol', async () => {
    const inside = await mkUser('dentro2@a.com', S1._id);
    const tok = adminToken('merch-A', R1._id);
    const toNull = await request(app).patch(`/portal/users/${inside._id}`).set('Authorization', `Bearer ${tok}`).send({ hierarchyNodeId: null });
    expect(toNull.status).toBe(403);
    expect(toNull.body.error).toBe('outside_your_scope');
    const toR2 = await request(app).patch(`/portal/users/${inside._id}`).set('Authorization', `Bearer ${tok}`).send({ hierarchyNodeId: S2._id });
    expect(toR2.status).toBe(403);
    const toR1 = await request(app).patch(`/portal/users/${inside._id}`).set('Authorization', `Bearer ${tok}`).send({ hierarchyNodeId: R1._id });
    expect(toR1.status).toBe(200);
  });

  test('alta por un admin restringido: sin nodo hereda el suyo; fuera de su subárbol → 403', async () => {
    const tok = adminToken('merch-A', R1._id);
    const plain = await request(app).post('/portal/users').set('Authorization', `Bearer ${tok}`).send({ name: 'N', email: 'nuevo@a.com', role: 'merchant_admin' });
    expect(plain.status).toBe(201);
    expect(plain.body.user.hierarchyNodeId).toBe(R1._id);
    const out = await request(app).post('/portal/users').set('Authorization', `Bearer ${tok}`).send({ name: 'N2', email: 'nuevo2@a.com', role: 'merchant_viewer', hierarchyNodeId: R2._id });
    expect(out.status).toBe(403);
    const none = await request(app).post('/portal/users').set('Authorization', `Bearer ${tok}`).send({ name: 'N3', email: 'nuevo3@a.com', role: 'merchant_viewer', hierarchyNodeId: null });
    expect(none.status).toBe(403);
    expect(MerchantUser.__store.find(u => u.email === 'nuevo2@a.com')).toBeUndefined();
  });

  test('un admin SIN restricción sí puede crear usuarios sin nodo o en cualquier nodo del merchant', async () => {
    const tok = adminToken('merch-A');
    const none = await request(app).post('/portal/users').set('Authorization', `Bearer ${tok}`).send({ name: 'Z', email: 'z@a.com', role: 'merchant_viewer' });
    expect(none.status).toBe(201);
    expect(none.body.user.hierarchyNodeId).toBeNull();
    const inR2 = await request(app).post('/portal/users').set('Authorization', `Bearer ${tok}`).send({ name: 'Z2', email: 'z2@a.com', role: 'merchant_viewer', hierarchyNodeId: R2._id });
    expect(inR2.status).toBe(201);
    expect(inR2.body.user.hierarchyNodeId).toBe(R2._id);
  });

  test('mover a un usuario de nodo cierra sus sesiones abiertas (su token viejo → 401)', async () => {
    const opTok = opToken('merch-A', R1._id);
    expect((await request(app).get('/portal/hierarchy').set('Authorization', `Bearer ${opTok}`)).status).toBe(200);
    const res = await request(app).patch(`/portal/users/op-merch-A-${R1._id}`)
      .set('Authorization', `Bearer ${adminToken('merch-A')}`).send({ hierarchyNodeId: R2._id });
    expect(res.status).toBe(200);
    expect(res.body.sessionsRevoked).toBe(true);
    const after = await request(app).get('/portal/hierarchy').set('Authorization', `Bearer ${opTok}`);
    expect(after.status).toBe(401);
    expect(after.body.error).toBe('session_revoked');
  });
});
