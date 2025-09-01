'use strict';

module.exports = function cspStrict() {
  const frameAncestors = process.env.CSP_FRAME_ANCESTORS || "'self'";
  const connectExtra = (process.env.CSP_CONNECT_EXTRA || '').split(',').map(s => s.trim()).filter(Boolean);

  const frameSrc = ["'self'", "https://pay.google.com"];
  const connectSrc = [
    "'self'",
    "https://pay.google.com",
    "https://*.google.com",
    "https://*.gstatic.com",
    "https://apple-pay-gateway.apple.com",
    ...connectExtra
  ];
  const imgSrc = ["'self'", "data:"];
  const styleSrc = ["'self'", "'unsafe-inline'"];
  const scriptSrc = ["'self'"];

  const csp = [
    `default-src 'none'`,
    `base-uri 'none'`,
    `frame-ancestors ${frameAncestors}`,
    `frame-src ${frameSrc.join(' ')}`,
    `connect-src ${connectSrc.join(' ')}`,
    `img-src ${imgSrc.join(' ')}`,
    `style-src ${styleSrc.join(' ')}`,
    `script-src ${scriptSrc.join(' ')}`
  ].join('; ');

  return function cspStrictMiddleware(_, res, next) {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  };
};
