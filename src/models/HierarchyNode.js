// src/models/HierarchyNode.js
'use strict';
//
// HierarchyNode — nodo del ÁRBOL de jerarquía de tiendas de un merchant (M6 Fase 2).
//
// REACTIVACIÓN de la jerarquía que estaba en standby (antes `MerchantHierarchy.js`,
// retirado en esta fase). El modelo viejo era un REGISTRO PLANO por tienda
// (globalGroup/group/branch/region/merchantId como strings en un solo doc, con
// `merchantId` = id de tienda ÚNICO global). Eso NO era un árbol y confundía dos
// cosas con el mismo nombre `merchantId`:
//   - el TENANT (el cliente de Monetiser, p.ej. `demo-merchant`) — como en el resto
//     del sistema (Merchant / Transaction / MerchantUser),
//   - la TIENDA hoja (p.ej. `zara_mad_001`).
//
// Aquí se rehace como un ÁRBOL por-tenant con lista de adyacencia (`parentId`):
//   - `merchantId` = TENANT dueño (coherente con todo el sistema, INMUTABLE),
//   - `nodeType`   = nivel del nodo (globalGroup → group → branch → region → store),
//   - `parentId`   = nodo padre (null = raíz).
//
// COLECCIÓN `hierarchynodes` (NUEVA, distinta de la vieja `merchanthierarchies`)
// a propósito: si una versión antigua hubiera dejado datos/índices en la colección
// vieja, no colisionan con esto. La vieja queda intacta y aparte.
//
// Aislamiento: todo el CRUD del portal filtra por `merchantId` de la SESIÓN; los
// nodos de otro merchant no existen para esa sesión (404). Ver portalHierarchyRoutes.
//
const mongoose = require('mongoose');
const { NODE_TYPES } = require('../utils/hierarchyLevels');

const hierarchyNodeSchema = new mongoose.Schema({
  // Tenant dueño (INMUTABLE). Todo el aislamiento va por aquí, resuelto por sesión.
  merchantId: { type: String, required: true, immutable: true },

  nodeType: { type: String, enum: NODE_TYPES, required: true },
  name:     { type: String, required: true, trim: true },

  // Código propio del merchant para el nodo (opcional; p.ej. `zara_mad_001`).
  // No único en v1 (se puede añadir un índice único por-tenant más adelante).
  code:     { type: String, default: null, trim: true },

  // Padre en el árbol. null = raíz. Debe ser del MISMO merchant y de nivel superior.
  parentId: { type: mongoose.Schema.Types.ObjectId, ref: 'HierarchyNode', default: null },

  active:    { type: Boolean, default: true },

  createdBy: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
}, { collection: 'hierarchynodes' });

hierarchyNodeSchema.index({ merchantId: 1, parentId: 1 });
hierarchyNodeSchema.index({ merchantId: 1, nodeType: 1 });

hierarchyNodeSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.models.HierarchyNode ||
  mongoose.model('HierarchyNode', hierarchyNodeSchema);
