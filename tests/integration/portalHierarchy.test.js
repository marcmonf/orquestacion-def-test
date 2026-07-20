// tests/integration/portalHierarchy.test.js
'use strict';
//
// Jerarquía de tiendas (M6 Fase 2): CRUD, reglas del árbol (nivel del padre),
// gates por rol y AISLAMIENTO de tenant (A no ve/toca/cuelga de nodos de B).
// Tokens firmados directamente para aislar la capa de autorización.
//
process.env.PORTAL_JWT_SECRET = 'test_portal_secret';

const express = require('express');
const request = require('supertest');

jest.mock('../../src/models/HierarchyNode', () => require('../helpers/memoryModel')());

const HierarchyNode = require('../../src/models/HierarchyNode');
const { signPortalToken } = require('../../src/middleware/portalAuth');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/portal/hierarchy', require('../../src/routes/portalHierarchyRoutes'));
  return app;
}

function token(merchantId, role = 'merchant_admin') {
  return signPortalToken({
    userId: `u-${merchantId}`, merchantId, email: `admin@${merchantId}.com`,
    role, mustChangePassword: false,
  });
}

const tokA = token('merch-A');
const tokB = token('merch-B');

function create(app, tok, body) {
  return request(app).post('/portal/hierarchy').set('Authorization', `Bearer ${tok}`).send(body);
}

describe('Portal hierarchy — CRUD y reglas del árbol', () => {
  let app, gA, grpA, grpA2, storeA;
  beforeAll(() => { app = buildApp(); });
  beforeEach(async () => {
    HierarchyNode.__reset();
    gA     = (await create(app, tokA, { nodeType: 'globalGroup', name: 'A Global' })).body.node;
    grpA   = (await create(app, tokA, { nodeType: 'group',  name: 'A Group',  parentId: gA._id })).body.node;
    grpA2  = (await create(app, tokA, { nodeType: 'group',  name: 'A Group 2', parentId: gA._id })).body.node;
    storeA = (await create(app, tokA, { nodeType: 'store',  name: 'A Store',  parentId: grpA._id })).body.node;
  });

  test('crea raíz sin padre (parentId null)', async () => {
    expect(gA._id).toBeDefined();
    expect(gA.parentId).toBeNull();
    expect(gA.merchantId).toBe('merch-A');
  });

  test('crea hijo con padre de nivel superior', async () => {
    expect(grpA.parentId).toBe(gA._id);
  });

  test('permite saltar niveles (store colgando de group)', async () => {
    expect(storeA.parentId).toBe(grpA._id);
    expect(storeA.nodeType).toBe('store');
  });

  test('400 — padre de nivel igual o inferior (store bajo store)', async () => {
    const res = await create(app, tokA, { nodeType: 'store', name: 'Otra', parentId: storeA._id });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_parent_level');
  });

  test('404 — padre inexistente', async () => {
    const res = await create(app, tokA, { nodeType: 'store', name: 'Huérfana', parentId: 'no-existe' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('parent_not_found');
  });

  test('400 — nodeType inválido', async () => {
    const res = await create(app, tokA, { nodeType: 'planeta', name: 'X' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_node_type');
  });

  test('400 — falta el nombre', async () => {
    const res = await create(app, tokA, { nodeType: 'store' });
    expect(res.status).toBe(400);
  });

  test('GET lista los nodos del propio merchant', async () => {
    const res = await request(app).get('/portal/hierarchy').set('Authorization', `Bearer ${tokA}`);
    expect(res.status).toBe(200);
    expect(res.body.nodes.length).toBe(4);
    expect(res.body.nodes.every(n => n.merchantId === 'merch-A')).toBe(true);
  });

  test('PATCH renombra un nodo', async () => {
    const res = await request(app).patch(`/portal/hierarchy/${storeA._id}`)
      .set('Authorization', `Bearer ${tokA}`).send({ name: 'A Store (renombrada)' });
    expect(res.status).toBe(200);
    expect(res.body.node.name).toBe('A Store (renombrada)');
  });

  test('PATCH mueve un nodo a otro padre válido', async () => {
    const res = await request(app).patch(`/portal/hierarchy/${storeA._id}`)
      .set('Authorization', `Bearer ${tokA}`).send({ parentId: grpA2._id });
    expect(res.status).toBe(200);
    expect(res.body.node.parentId).toBe(grpA2._id);
  });

  test('PATCH — un nodo no puede ser su propio padre', async () => {
    const res = await request(app).patch(`/portal/hierarchy/${grpA._id}`)
      .set('Authorization', `Bearer ${tokA}`).send({ parentId: grpA._id });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('node_cannot_be_its_own_parent');
  });

  test('PATCH desactiva un nodo', async () => {
    const res = await request(app).patch(`/portal/hierarchy/${storeA._id}`)
      .set('Authorization', `Bearer ${tokA}`).send({ active: false });
    expect(res.status).toBe(200);
    expect(res.body.node.active).toBe(false);
  });

  test('DELETE borra una hoja', async () => {
    const res = await request(app).delete(`/portal/hierarchy/${storeA._id}`).set('Authorization', `Bearer ${tokA}`);
    expect(res.status).toBe(200);
    const list = await request(app).get('/portal/hierarchy').set('Authorization', `Bearer ${tokA}`);
    expect(list.body.nodes.map(n => n._id)).not.toContain(storeA._id);
  });

  test('DELETE — 409 si el nodo tiene hijos', async () => {
    const res = await request(app).delete(`/portal/hierarchy/${gA._id}`).set('Authorization', `Bearer ${tokA}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('node_has_children');
  });
});

describe('Portal hierarchy — gates por rol', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  beforeEach(() => { HierarchyNode.__reset(); });

  test('403 — merchant_viewer no puede crear', async () => {
    const res = await create(app, token('merch-A', 'merchant_viewer'), { nodeType: 'globalGroup', name: 'X' });
    expect(res.status).toBe(403);
  });

  test('200 — merchant_viewer SÍ puede leer', async () => {
    const res = await request(app).get('/portal/hierarchy').set('Authorization', `Bearer ${token('merch-A', 'merchant_viewer')}`);
    expect(res.status).toBe(200);
  });

  test('403 — merchant_operator no puede borrar', async () => {
    const created = await create(app, tokA, { nodeType: 'globalGroup', name: 'Root' });
    const res = await request(app).delete(`/portal/hierarchy/${created.body.node._id}`)
      .set('Authorization', `Bearer ${token('merch-A', 'merchant_operator')}`);
    expect(res.status).toBe(403);
  });
});

describe('Portal hierarchy — AISLAMIENTO de tenant', () => {
  let app, aNode, bNode;
  beforeAll(() => { app = buildApp(); });
  beforeEach(async () => {
    HierarchyNode.__reset();
    aNode = (await create(app, tokA, { nodeType: 'globalGroup', name: 'A Global' })).body.node;
    bNode = (await create(app, tokB, { nodeType: 'globalGroup', name: 'B Global' })).body.node;
  });

  test('A solo ve sus nodos (nunca los de B)', async () => {
    const res = await request(app).get('/portal/hierarchy').set('Authorization', `Bearer ${tokA}`);
    expect(res.body.nodes.every(n => n.merchantId === 'merch-A')).toBe(true);
    expect(res.body.nodes.map(n => n._id)).not.toContain(bNode._id);
  });

  test('A NO puede editar un nodo de B (404)', async () => {
    const res = await request(app).patch(`/portal/hierarchy/${bNode._id}`)
      .set('Authorization', `Bearer ${tokA}`).send({ name: 'hackeado' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('node_not_found');
    const stillB = HierarchyNode.__store.find(n => n._id === bNode._id);
    expect(stillB.name).toBe('B Global');
  });

  test('A NO puede borrar un nodo de B (404)', async () => {
    const res = await request(app).delete(`/portal/hierarchy/${bNode._id}`).set('Authorization', `Bearer ${tokA}`);
    expect(res.status).toBe(404);
    expect(HierarchyNode.__store.some(n => n._id === bNode._id)).toBe(true);
  });

  test('A NO puede colgar su árbol de un nodo de B (parentId cross-tenant → 404)', async () => {
    const res = await create(app, tokA, { nodeType: 'group', name: 'A Group', parentId: bNode._id });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('parent_not_found');
  });

  test('El merchantId del body se ignora al crear (manda la sesión)', async () => {
    const res = await create(app, tokA, { nodeType: 'globalGroup', name: 'Intruso', merchantId: 'merch-B' });
    expect(res.status).toBe(201);
    expect(res.body.node.merchantId).toBe('merch-A');
  });
});
