// src/middleware/rateLimiterPortalLogin.js
'use strict';
//
// Rate limit del LOGIN del portal (requisito duro M6). Frena la fuerza bruta
// contra las credenciales de los usuarios de merchant.
//
// Dos límites (ver src/middleware/rateLimiterLogin.js):
//   - por IP + email → RL_PORTAL_LOGIN_MAX (10) por ventana RL_PORTAL_LOGIN_WINDOW_MS (15 min)
//   - solo por email (ataque distribuido desde muchas IPs) → RL_PORTAL_LOGIN_MAX_PER_EMAIL (30)
//
// Nota: el comentario anterior afirmaba que la clave IP+email impedía "rotar
// cuentas desde una misma IP". No era así (cada email estrenaba contador); eso
// lo frena el rate limit global por IP.
//
const { makeLoginLimiters } = require('./rateLimiterLogin');

module.exports = makeLoginLimiters({
  name:          'portal',
  windowMs:      parseInt(process.env.RL_PORTAL_LOGIN_WINDOW_MS || '900000', 10), // 15 min
  maxPerIpEmail: parseInt(process.env.RL_PORTAL_LOGIN_MAX || '10', 10),
  maxPerEmail:   parseInt(process.env.RL_PORTAL_LOGIN_MAX_PER_EMAIL || '30', 10),
});
