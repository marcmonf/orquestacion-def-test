// src/utils/tempPassword.js
'use strict';
//
// Password temporal para el alta de usuarios de merchant (M6). No hay
// infraestructura de email: el alta genera esta credencial de un solo uso, se
// muestra UNA vez a quien crea el usuario, y el usuario está obligado a
// cambiarla en el primer login (mustChangePassword).
//
const crypto = require('crypto');

// 12 caracteres base64url (~72 bits de entropía). URL-safe y copy-paste-able
// para entrega manual. Es un secreto efímero: se sustituye en el primer login.
function generateTempPassword() {
  return crypto.randomBytes(9).toString('base64url');
}

module.exports = { generateTempPassword };
