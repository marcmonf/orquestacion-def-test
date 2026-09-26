// src/utils/hierarchyScope.js
'use strict';
//
// Permisos por nodo de la jerarquía de tiendas (M6 Fase 4), compartidos por
// /portal/hierarchy y /portal/users.
//
// Un usuario del portal asignado a un nodo (MerchantUser.hierarchyNodeId) solo
// ve y gestiona SU SUBÁRBOL (ese nodo + descendientes). Sin asignación (null) ve
// todo su merchant.

const HierarchyNode = require('../models/HierarchyNode');

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
async function allowedNodeIds(portalUser) {
  if (!portalUser || !portalUser.hierarchyNodeId) return null;
  const all = await HierarchyNode.find({ merchantId: portalUser.merchantId }).lean();
  return subtreeIds(all, portalUser.hierarchyNodeId);
}

module.exports = { subtreeIds, allowedNodeIds };
