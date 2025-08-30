// src/middleware/securityHeaders.js
const helmet = require('helmet');

module.exports = function securityHeaders() {
  const cspDirectives = {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc:  ["'self'", "'unsafe-inline'"],
    imgSrc:    ["'self'", 'data:'],
    connectSrc:["'self'"],
    frameAncestors: ["'none'"], // Iframe servido por subdominio propio
    baseUri: ["'self'"],
    fontSrc: ["'self'", 'data:'],
    objectSrc: ["'none'"],
    formAction: ["'self'"]
  };

  return [
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: cspDirectives
      },
      referrerPolicy: { policy: 'no-referrer' },
      frameguard: { action: 'deny' },
      hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true
      },
      noSniff: true,
      xssFilter: true
    })
  ];
};
