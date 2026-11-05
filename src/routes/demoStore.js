// src/routes/demoStore.js
'use strict';
//
// TIENDA DE DEMOSTRACIÓN /demo (sesión 5 nov 2026, F2 escaparate).
//
// "Alfar Brisa": marca, logo y productos INVENTADOS (ninguna marca real). Sirve
// para enseñar Monetiser como lo vería un comercio: catálogo, carrito, pago con
// monetiser.js (checkout embebido), enlace de pago y QR.
//
// Su "backend de comercio" vive AQUÍ, en el servidor: usa una clave API de
// PRUEBAS de un comercio de Monetiser, DEMO_STORE_SECRET (la pone Marcos en
// Render; nunca en el repo). El secreto JAMÁS llega al navegador: el navegador
// solo manda SKUs y cantidades; el importe lo calcula el servidor.
//
// Solo existe con MONETISER_ENV=sandbox (explícito). En cualquier otro caso:
// 404 en todo /demo. Límite de peticiones por IP en /demo/api.

const path = require('path');
const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { authenticateSecret } = require('../services/apiKeyService');
const sessions = require('../services/checkoutSessionService');
const paymentLinks = require('../services/paymentLinkService');
const logger = require('../utils/logger');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public', 'demo');

// Catálogo inventado. Precios en céntimos, EUR.
const CATALOG = Object.freeze([
  { sku: 'taza-marea',    name: 'Taza Marea',    description: 'Gres esmaltado azul profundo, 350 ml.', price: 1800, color: '#2f6f8f' },
  { sku: 'cuenco-duna',   name: 'Cuenco Duna',   description: 'Cuenco ancho color arena, hecho a torno.', price: 2400, color: '#c9a46a' },
  { sku: 'jarra-bruma',   name: 'Jarra Bruma',   description: 'Jarra de 1 litro, blanco roto mate.', price: 3200, color: '#b9c2c7' },
  { sku: 'plato-salitre', name: 'Plato Salitre', description: 'Plato llano con borde salpicado.', price: 1500, color: '#6d8f7a' },
]);
const COUNTRIES = Object.freeze(['ES', 'PT', 'FR', 'DE', 'IT', 'GB', 'US']);
const MAX_QTY = 10;

function enabled() {
  return String(process.env.MONETISER_ENV || '').trim().toLowerCase() === 'sandbox';
}

router.use((req, res, next) => (enabled() ? next() : res.status(404).send('Not found')));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.DEMO_RATE_LIMIT_PER_MIN) > 0 ? Number(process.env.DEMO_RATE_LIMIT_PER_MIN) : 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'rate_limited', message: 'Demasiadas peticiones. Espera un minuto.' },
});
router.use('/api', limiter);

// Precio del carrito en el SERVIDOR (el navegador nunca fija el importe).
function priceCart(items) {
  if (!Array.isArray(items) || !items.length || items.length > CATALOG.length) return null;
  let amount = 0;
  const lines = [];
  for (const it of items) {
    const p = CATALOG.find((c) => c.sku === (it && it.sku));
    const qty = Number(it && it.qty);
    if (!p || !Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) return null;
    if (lines.some((l) => l.sku === p.sku)) return null;
    amount += p.price * qty;
    lines.push({ sku: p.sku, qty });
  }
  return { amount, lines };
}

// Comercio de la tienda demo, a partir de la clave de pruebas del servidor.
async function demoMerchant(req) {
  const secret = process.env.DEMO_STORE_SECRET;
  if (!secret) return { error: [503, 'demo_not_configured', 'La tienda demo no está configurada (DEMO_STORE_SECRET).'] };
  const auth = await authenticateSecret(secret, req.ip || null);
  if (!auth) return { error: [503, 'demo_not_configured', 'La clave de la tienda demo no es válida o está revocada.'] };
  if (auth.livemode) return { error: [503, 'demo_live_key', 'La tienda demo solo funciona con una clave de PRUEBAS.'] };
  return { merchantId: auth.merchantId };
}

function fail(res, [status, error, message]) {
  return res.status(status).json({ success: false, error, message });
}

function orderRef() {
  return `BRISA-${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 1296).toString(36).toUpperCase()}`;
}

router.get('/api/catalog', (req, res) => {
  res.json({ success: true, currency: 'EUR', products: CATALOG, countries: COUNTRIES });
});

router.post('/api/checkout', async (req, res) => {
  const body = req.body || {};
  const cart = priceCart(body.items);
  if (!cart) return fail(res, [400, 'invalid_cart', 'Carrito no válido.']);
  const country = COUNTRIES.includes(String(body.country || '').toUpperCase()) ? String(body.country).toUpperCase() : null;
  try {
    const m = await demoMerchant(req);
    if (m.error) return fail(res, m.error);
    const base = sessions.resolveBaseUrl(req);
    const reference = orderRef();
    const { tx } = await sessions.createCheckoutSession(m.merchantId, {
      amount: cart.amount, currency: 'EUR', reference, country, livemode: false,
      returnUrl: base ? `${base}/demo?pedido=${encodeURIComponent(reference)}` : null,
    });
    const s = sessions.toCheckoutSession(tx, base);
    logger.info('DEMO_STORE_CHECKOUT', { component: 'demoStore', paymentId: s.id, data: { amount: cart.amount, country } });
    return res.status(201).json({ success: true, paymentId: s.id, reference, amount: cart.amount, currency: 'EUR', url: s.url });
  } catch (err) {
    if (err.code === 'no_connector_available') return fail(res, [422, 'no_connector_available', 'Ningún adquirente puede cobrar este pedido.']);
    logger.error('DEMO_STORE_CHECKOUT_ERROR', { component: 'demoStore', data: { error: err.message } });
    return fail(res, [500, 'internal_error', 'No se pudo iniciar el pago.']);
  }
});

router.post('/api/payment-link', async (req, res) => {
  const cart = priceCart((req.body || {}).items);
  if (!cart) return fail(res, [400, 'invalid_cart', 'Carrito no válido.']);
  try {
    const m = await demoMerchant(req);
    if (m.error) return fail(res, m.error);
    const base = sessions.resolveBaseUrl(req);
    const reference = orderRef();
    const link = await paymentLinks.create(m.merchantId, {
      amount: cart.amount, currency: 'EUR', concept: 'Pedido Alfar Brisa (demo)', reference,
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    }, { livemode: false, createdBy: 'demo_store', channel: 'demo' });
    const p = paymentLinks.toPublic(link, base);
    return res.status(201).json({ success: true, reference, amount: cart.amount, currency: 'EUR', url: p.url, qrUrl: p.qrUrl });
  } catch (err) {
    logger.error('DEMO_STORE_LINK_ERROR', { component: 'demoStore', data: { error: err.message } });
    return fail(res, [err.httpStatus || 500, err.code || 'internal_error', 'No se pudo crear el enlace de pago.']);
  }
});

router.get('/api/order/:paymentId', async (req, res) => {
  try {
    const m = await demoMerchant(req);
    if (m.error) return fail(res, m.error);
    const tx = await sessions.findPayment(m.merchantId, String(req.params.paymentId), false);
    if (!tx) return fail(res, [404, 'not_found', 'Pedido no encontrado.']);
    return res.json({ success: true, paymentId: tx.paymentId, reference: tx.merchantReference || null, status: tx.status, connector: tx.processor || (tx.routing && tx.routing.connector) || null, routingReason: (tx.routing && tx.routing.reason) || null });
  } catch (err) {
    return fail(res, [500, 'internal_error', 'No se pudo consultar el pedido.']);
  }
});

// CSP propia: el checkout embebido navega (3DS) dentro de su iFrame a dominios
// del PSP y del banco, y la CSP de la página manda también ahí (ver
// /test-checkout.html en index.js): frame-src 'self' https:.
router.get('/', (req, res) => {
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
    "frame-src 'self' https:; connect-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'");
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});
router.use(express.static(PUBLIC_DIR, { index: false }));

module.exports = router;
module.exports._test = { CATALOG, priceCart, enabled };
