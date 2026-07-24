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
// borrar) solo `merchant_admin`.
//
// PERMISOS POR NODO (Fase 4): si el usuario está asignado a un nodo
// (MerchantUser.hierarchyNodeId, que viaja en el JWT), solo ve y gestiona SU
// SUBÁRBOL; fuera de él los nodos "no existen" (404) y no puede crear/mover ahí
// (403 outside_your_scope). Sin asignación (null) ve todo su merchant. La
// asignación la hace un merchant_admin con PATCH /portal/users/:id.
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

// ── Fase 4 — permisos por nodo ──────────────────────────────────────────────
// Si el usuario está asignado a un nodo (req.portalUser.hierarchyNodeId), solo ve
// y gestiona SU SUBÁRBOL (ese nodo + descendientes). Sin asignación (null) ve todo
// su merchant. Nota: el scoping por nodo aplica a la JERARQUÍA; las transacciones
// no llevan referencia de nodo todavía, así que su visibilidad sigue siendo a
// nivel de merchant (mejora futura: etiquetar transacciones con un nodo).

// Ids del subárbol que cuelga de rootId (incluido rootId), a partir de la lista
// completa de nodos del merchant.
function subtreeIds(nodes, rootId) {
  const childrenOf = {};
  nodes.forEach(n => {
    const p = n.parentId ? String(n.parentId) : 'null';
    (childrenOf[p] = childrenOf[p] || []).push(String(n._id));
  });
  const out = new Set();
  const stack = [String(rootId)];
  while (stack.length) {
    const cur = stack.pop();
    if (out.has(cur)) continue;
    out.add(cur);
    (childrenOf[cur] || []).forEach(c => stack.push(c));
  }
  return out;
}

// null = usuario no restringido (ve todo su merchant). Set = ids de su subárbol.
async function allowedNodeIds(req) {
  if (!req.portalUser.hierarchyNodeId) return null;
  const all = await HierarchyNode.find({ merchantId: req.portalUser.merchantId }).lean();
  return subtreeIds(all, req.portalUser.hierarchyNodeId);
}

router.use(portalAuth);
router.use(requirePasswordChanged);

// ─────────────────────────────────────────────
// GET /portal/hierarchy — nodos del PROPIO merchant (lista plana con parentId)
// Lectura permitida a cualquier usuario del portal.
// ─────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const all = await HierarchyNode
      .find({ merchantId: req.portalUser.merchantId })   // ← scope de la sesión (merchant)
      .sort({ nodeType: 1, name: 1 })
      .lean();
    // Scoping por nodo (Fase 4): si el usuario está asignado a un nodo, solo su subárbol.
    let nodes = all;
    if (req.portalUser.hierarchyNodeId) {
      const ids = subtreeIds(all, req.portalUser.hierarchyNodeId);
      nodes = all.filter(n => ids.has(String(n._id)));
    }
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

    // Fase 4 — un usuario restringido a un nodo solo puede crear DENTRO de su
    // subárbol: el padre es obligatorio y debe pertenecer a su subárbol.
    const allowed = await allowedNodeIds(req);
    if (allowed && (!pr.parent || !allowed.has(String(pr.parent._id)))) {
      return res.status(403).json({ success: false, error: 'outside_your_scope' });
    }

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

    // Fase 4 — un usuario restringido a un nodo solo toca su subárbol; fuera de él
    // el nodo "no existe" (404, no se revela).
    const allowed = await allowedNodeIds(req);
    if (allowed && !allowed.has(String(node._id))) {
      return res.status(404).json({ success: false, error: 'node_not_found' });
    }

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
        // Sacar el nodo a raíz lo saca del subárbol de un usuario restringido.
        if (allowed) return res.status(403).json({ success: false, error: 'outside_your_scope' });
        node.parentId = null;
      } else if (String(newParentId) === String(node._id)) {
        return res.status(400).json({ success: false, error: 'node_cannot_be_its_own_parent' });
      } else {
        // resolveParent exige mismo merchant + nivel superior. Esa regla de nivel
        // hace además imposible un ciclo (el padre siempre está por encima).
        const pr = await resolveParent(req.portalUser.merchantId, newParentId, node.nodeType);
        if (!pr.ok) return res.status(pr.code).json({ success: false, error: pr.error });
        if (allowed && !allowed.has(String(pr.parent._id))) {
          return res.status(403).json({ success: false, error: 'outside_your_scope' });
        }
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

    // Fase 4 — fuera de su subárbol, el nodo "no existe" para un usuario restringido.
    const allowed = await allowedNodeIds(req);
    if (allowed && !allowed.has(String(node._id))) {
      return res.status(404).json({ success: false, error: 'node_not_found' });
    }

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
