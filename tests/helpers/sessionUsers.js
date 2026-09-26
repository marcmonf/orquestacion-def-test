// tests/helpers/sessionUsers.js
'use strict';
//
// Tokens de sesión para tests que los firman a mano.
//
// Desde el 26 sep 2026 portalAuth y backofficeAuth comprueban en CADA petición
// que el usuario del token existe, está activo y conserva la misma versión de
// sesión (revocación de sesiones), y toman el rol/alcance/nodo de la base de
// datos, no del token. Así que un token "suelto" ya no basta: estos helpers
// firman el token Y dejan el usuario correspondiente en el modelo en memoria
// (el test tiene que mockear MerchantUser / BackofficeUser con memoryModel).
// Si el usuario ya existe, se actualiza con los datos del token.

function upsert(Model, doc) {
  const existing = Model.__store.find(u => String(u._id) === String(doc._id));
  if (existing) {
    Object.assign(existing, doc, { tokenVersion: existing.tokenVersion || 0 });
    return existing;
  }
  Model.create({ tokenVersion: 0, ...doc });
  return Model.__store.find(u => String(u._id) === String(doc._id));
}

function portalToken(claims) {
  const MerchantUser = require('../../src/models/MerchantUser');
  const { signPortalToken } = require('../../src/middleware/portalAuth');
  const user = upsert(MerchantUser, {
    _id:                String(claims.userId),
    merchantId:         claims.merchantId,
    email:              claims.email,
    name:               claims.name || claims.email,
    passwordHash:       'not-a-real-hash',
    role:               claims.role,
    active:             true,
    mustChangePassword: !!claims.mustChangePassword,
    hierarchyNodeId:    claims.hierarchyNodeId || null,
  });
  return signPortalToken({ ...claims, tv: user.tokenVersion || 0 });
}

function backofficeToken(claims) {
  const BackofficeUser = require('../../src/models/BackofficeUser');
  const { signBackofficeToken } = require('../../src/middleware/backofficeAuth');
  const user = upsert(BackofficeUser, {
    _id:           String(claims.userId),
    email:         claims.email,
    name:          claims.name || claims.email,
    passwordHash:  'not-a-real-hash',
    role:          claims.role,
    merchantScope: claims.merchantScope || [],
    active:        true,
  });
  return signBackofficeToken({ ...claims, tv: user.tokenVersion || 0 });
}

module.exports = { portalToken, backofficeToken };
