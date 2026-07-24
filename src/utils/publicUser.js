// src/utils/publicUser.js
'use strict';
//
// Proyección pública de un MerchantUser: allowlist EXPLÍCITA de campos seguros.
// En ninguna respuesta se hace spread del documento crudo — así el passwordHash
// (ni ningún campo sensible futuro) puede escaparse por olvido, tenga o no un
// .select() por delante. La seguridad vive aquí, no en el ORM.
//
function toPublicUser(u) {
  if (!u) return null;
  return {
    _id:                u._id,
    merchantId:         u.merchantId,
    email:              u.email,
    name:               u.name,
    role:               u.role,
    active:             u.active,
    mustChangePassword: u.mustChangePassword,
    hierarchyNodeId:    u.hierarchyNodeId ? String(u.hierarchyNodeId) : null,
    lastLoginAt:        u.lastLoginAt || null,
    createdAt:          u.createdAt,
  };
}

module.exports = { toPublicUser };
