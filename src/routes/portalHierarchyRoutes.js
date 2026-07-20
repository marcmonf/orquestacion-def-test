// src/routes/portalHierarchyRoutes.js
'use strict';
//
// Jerarquía de tiendas del merchant (M6 Fase 2) — CRUD scoped a la SESIÓN.
//
// Mismo blindaje que el resto del portal: el `merchantId` sale SIEMPRE de
// req.portalUser.merchantId, NUNCA del cliente. Todo nodo se resuelve con ese
// merchantId en el filtro → un nodo de otro merchant no existe para esta sesión
// (404). Un `parentId` que apunte a un nodo de otro merchant tampoco se encuentra
// (404 parent_not_found): no se puede colgar el árbol propio de otro tenant.
//
// Roles: LECTURA (GET) para cualquier usuario del portal; ESCRITURA (crear/editar/
// borrar) solo `merchant_admin`. V1 = gestionar la ESTRUCTURA; la asignación de
// usuarios/permisos a nodos concretos queda para la Fase 4 (campo puente
// MerchantUser.hierarchyNodeId, hoy dormido).
//
const express       = require('express');
const router        = express.Router();
const HierarchyNode = require('../models/HierarchyNode');
const portalAuth    = require('../middleware/portalAuth');
const { requirePortalRole, requirePasswordChanged } = portalAuth;
const { NODE_TYPES, RANK } = require('../utils/hierarchyLevels');

function toPublicNode(n) {
  if (!n) return null;
  return {
    _id:        n._id,
    merchantId: n.merchantId,
    nodeType:   n.nodeType,
    name:       n.name,
    code:       n.code || null,
    parentId:   n.parentId ? String(n.parentId) : null,
    active:     n.active,
    createdAt:  n.createdAt,
  };
}

// Valida el parentId (si viene): mismo merchant y nivel estrictamente superior.
// Devuelve { ok, parent } o { ok:false, code, error }.
async function resolveParent(merchantId, parentId, childType) {
  if (parentId === undefined || parentId === null || parentId === '') {
    return { ok: true, parent: null };
  }
  const parent = await HierarchyNode.findOne({ _id: parentId, merchantId });
  if (!parent) return { ok: false, code: 404, error: 'parent_not_found' };
  if (RANK[parent.nodeType] >= RANK[childType]) {
    return { ok: false, code: 400, error: 'invalid_parent_level' };
  }
  return { ok: true, parent };
}

router.use(portalAuth);
router.use(requirePasswordChanged);

// ─────────────────────────────────────────────
// GET /portal/hierarchy — nodos del PROPIO merchant (lista plana con parentId)
// Lectura permitida a cualquier usuario del portal.
// ─────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const nodes = await HierarchyNode
      .find({ merchantId: req.portalUser.merchantId })   // ← scope de la sesión
      .sort({ nodeType: 1, name: 1 })
      .lean();
    return res.json({ success: true, nodes: nodes.map(toPublicNode) });
  } catch (err) {
    console.error('❌ [portal/hierarchy GET]', err);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

// ─────────────────────────────────────────────
// POST /portal/hierarchy — crear nodo (merchant_admin)
// ─────────────────────────────────────────────
router.post('/', requirePortalRole('merchant_admin'), async (req, res) => {
  const { nodeType, name, code = null, parentId = null } = req.body || {};
  if (!nodeType || !name) {
    return res.status(400).json({ success: false, error: 'nodeType_and_name_required' });
  }
  if (!NODE_TYPES.includes(nodeType)) {
    return res.status(400).json({ success: false, error: 'invalid_node_type' });
  }

  try {
    const pr = await resolveParent(req.portalUser.merchantId, parentId, nodeType);
    if (!pr.ok) return res.status(pr.code).json({ success: false, error: pr.error });

    const node = await HierarchyNode.create({
      merchantId: req.portalUser.merchantId,   // ← SIEMPRE la sesión; se ignora cualquier merchantId del body
      nodeType,
      name:       String(name).trim(),
      code:       code ? String(code).trim() : null,
      parentId:   pr.parent ? pr.parent._id : null,
      active:     true,
      createdBy:  req.portalUser.email || null,
    });
    return res.status(201).json({ success: true, node: toPublicNode(node) });
  } catch (err) {
    console.error('❌ [portal/hierarchy POST]', err);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

// ─────────────────────────────────────────────
// PATCH /portal/hierarchy/:nodeId — editar nombre/código/estado/padre (merchant_admin)
// ─────────────────────────────────────────────
router.patch('/:nodeId', requirePortalRole('merchant_admin'), async (req, res) => {
  try {
    const node = await HierarchyNode.findOne({
      _id:        req.params.nodeId,
      merchantId: req.portalUser.merchantId,   // ← nodo de otro merchant → no existe (404)
    });
    if (!node) return res.status(404).json({ success: false, error: 'node_not_found' });

    if (req.body.name !== undefined) {
      if (!String(req.body.name).trim()) {
        return res.status(400).json({ success: false, error: 'name_cannot_be_empty' });
      }
      node.name = String(req.body.name).trim();
    }
    if (req.body.code !== undefined) {
      node.code = req.body.code ? String(req.body.code).trim() : null;
    }
    if (req.body.active !== undefined) {
      node.active = !!req.body.active;
    }
    if (req.body.parentId !== undefined) {
      const newParentId = req.body.parentId;
      if (newParentId === null || newParentId === '') {
        node.parentId = null;
      } else if (String(newParentId) === String(node._id)) {
        return res.status(400).json({ success: false, error: 'node_cannot_be_its_own_parent' });
      } else {
        // resolveParent exige mismo merchant + nivel superior. Esa regla de nivel
        // hace además imposible un ciclo (el padre siempre está por encima).
        const pr = await resolveParent(req.portalUser.merchantId, newParentId, node.nodeType);
        if (!pr.ok) return res.status(pr.code).json({ success: false, error: pr.error });
        node.parentId = pr.parent._id;
      }
    }

    await node.save();
    return res.json({ success: true, node: toPublicNode(node) });
  } catch (err) {
    console.error('❌ [portal/hierarchy PATCH]', err);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

// ─────────────────────────────────────────────
// DELETE /portal/hierarchy/:nodeId — borrar (merchant_admin). Rechaza si tiene hijos.
// ─────────────────────────────────────────────
router.delete('/:nodeId', requirePortalRole('merchant_admin'), async (req, res) => {
  try {
    const node = await HierarchyNode.findOne({
      _id:        req.params.nodeId,
      merchantId: req.portalUser.merchantId,
    });
    if (!node) return res.status(404).json({ success: false, error: 'node_not_found' });

    const children = await HierarchyNode.countDocuments({
      merchantId: req.portalUser.merchantId,
      parentId:   node._id,
    });
    if (children > 0) {
      return res.status(409).json({ success: false, error: 'node_has_children' });
    }

    await HierarchyNode.deleteOne({ _id: node._id, merchantId: req.portalUser.merchantId });
    return res.json({ success: true, message: 'node_deleted', _id: String(node._id) });
  } catch (err) {
    console.error('❌ [portal/hierarchy DELETE]', err);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

module.exports = router;
