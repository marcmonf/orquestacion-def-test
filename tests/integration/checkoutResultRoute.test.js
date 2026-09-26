// tests/integration/checkoutResultRoute.test.js
'use strict';
//
// Página de resultado del checkout (/checkout/result/:paymentId) y su consulta
// de estado: firma y caducidad, datos escapados, cabeceras (CSP sin JavaScript
// en línea, embebible, sin caché) y resultado derivado SIEMPRE del estado
// guardado.

const express = require('express');
const request = require('supertest');

jest.mock('../../src/models/TraceLog', () => ({ TraceLog: null, isEnabled: false }));
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const mockTxs = new Map();
jest.mock('../../src/models/Transaction', () => ({
  findOne: jest.fn((filter) => ({ lean: async () => mockTxs.get(filter.paymentId) || null })),
}));
jest.mock('../../src/models/Merchant', () => ({
  findOne: jest.fn(() => ({ lean: async () => ({ name: 'Tienda Demo', logoUrl: 'javascript:alert(1)', brandColor: '#123456' }) })),
}));

const checkoutResult = require('../../src/utils/checkoutResult');

function buildApp() {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use('/checkout/result', require('../../src/routes/checkoutResult'));
  return app;
}

function seed(tx) {
  mockTxs.clear();
  mockTxs.set(tx.paymentId, {
    merchantId: 'demo-merchant', amount: 12345, currency: 'EUR', ...tx,
  });
}

// Se quitan antes los comentarios HTML: un bloque de datos que cae DENTRO de un
// comentario no existe para el navegador (pasó: la página decía "Enlace no
// válido" porque un comentario mencionaba la etiqueta de cierre de cabecera).
function runtimeOf(html) {
  const visible = html.replace(/<!--[\s\S]*?-->/g, '');
  const m = /<script type="application\/json" id="monetiser-runtime">([\s\S]*?)<\/script>\s*<\/head>/.exec(visible);
  return m ? JSON.parse(m[1]) : null;
}

describe('GET /checkout/result/:paymentId — página', () => {
  const app = buildApp();

  test('enlace válido → 200 con los datos del pago, cabeceras de seguridad y datos escapados', async () => {
    seed({
      paymentId: 'pay-1', status: 'authorized',
      merchantReference: '</script><script>alert(1)</script>',
      returnUrl: 'https://tienda.test/vuelta?pedido=77',
    });
    const res = await request(app).get(checkoutResult.resultPath('pay-1', 'ok'));
    expect(res.status).toBe(200);

    const csp = res.headers['content-security-policy'];
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("'unsafe-inline' https");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(csp).toContain('frame-ancestors *');
    expect(res.headers['x-frame-options']).toBeUndefined();
    expect(res.headers['cache-control']).toBe('no-store');

    // Nada del merchant puede cerrar el bloque de datos ni inyectar HTML.
    expect(res.text).not.toContain('</script><script>alert(1)');
    expect(res.text).toContain('<script src="/checkout-result.js" defer></script>');

    const rt = runtimeOf(res.text);
    expect(rt.paymentId).toBe('pay-1');
    expect(rt.status).toBe('authorized');
    expect(rt.result).toBe('succeeded');
    expect(rt.outcome).toBe('ok');
    expect(rt.amount).toBe('123.45');
    expect(rt.currency).toBe('EUR');
    expect(rt.merchantReference).toBe('</script><script>alert(1)</script>');
    expect(rt.branding.merchantName).toBe('Tienda Demo');
    expect(rt.branding.logoUrl).toBe('/Logo_Monetiser.png'); // javascript: descartado
    expect(rt.branding.brandColor).toBe('#123456');
    const back = new URL(rt.returnUrl);
    expect(back.searchParams.get('pedido')).toBe('77');
    expect(back.searchParams.get('paymentId')).toBe('pay-1');
    expect(back.searchParams.get('result')).toBe('succeeded');
    expect(rt.statusUrl).toMatch(/^\/checkout\/result\/pay-1\/status\?exp=\d+&sig=[0-9a-f]{64}$/);
  });

  test('el resultado sale del estado guardado, no del ok/ko de la URL', async () => {
    seed({ paymentId: 'pay-2', status: 'declined' });
    const res = await request(app).get(checkoutResult.resultPath('pay-2', 'ok'));
    expect(res.status).toBe(200);
    const rt = runtimeOf(res.text);
    expect(rt.outcome).toBe('ok');
    expect(rt.result).toBe('failed');
    expect(rt.returnUrl).toBeNull(); // sin returnUrl, no hay botón de vuelta
  });

  test('returnUrl no http(s) guardada → no se ofrece vuelta', async () => {
    seed({ paymentId: 'pay-3', status: 'pending_3ds', returnUrl: 'javascript:alert(1)' });
    const res = await request(app).get(checkoutResult.resultPath('pay-3', 'ko'));
    const rt = runtimeOf(res.text);
    expect(rt.result).toBe('pending');
    expect(rt.returnUrl).toBeNull();
  });

  test('firma falsa → 403; otro paymentId con firma ajena → 403 (página neutra, sin datos del pago)', async () => {
    seed({ paymentId: 'pay-1', status: 'authorized', merchantReference: 'PED-SECRETO' });
    const forged = `/checkout/result/pay-1?outcome=ok&exp=${Date.now() + 60000}&sig=${'0'.repeat(64)}`;
    const res = await request(app).get(forged);
    expect(res.status).toBe(403);
    // Misma página (dirá "Resultado no disponible"), sin bloque de datos: no
    // revela nada y no asusta a quien sí ha pagado con un "Acceso no autorizado".
    expect(res.text).toContain('<script src="/checkout-result.js" defer></script>');
    expect(runtimeOf(res.text)).toBeNull();
    expect(res.text).not.toContain('PED-SECRETO');
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
    const other = checkoutResult.resultPath('pay-9', 'ok').replace('/pay-9?', '/pay-1?');
    expect((await request(app).get(other)).status).toBe(403);
  });

  test('enlace caducado → 410 (página neutra)', async () => {
    seed({ paymentId: 'pay-1', status: 'authorized' });
    const old = checkoutResult.resultPath('pay-1', 'ok', Date.now() - checkoutResult.RESULT_TTL_MS - 1000);
    const res = await request(app).get(old);
    expect(res.status).toBe(410);
    expect(runtimeOf(res.text)).toBeNull();
  });

  test('pago inexistente (enlace bien firmado) → 404 (página neutra)', async () => {
    mockTxs.clear();
    const res = await request(app).get(checkoutResult.resultPath('nope', 'ok'));
    expect(res.status).toBe(404);
    expect(runtimeOf(res.text)).toBeNull();
  });

  test('POST (redirección con formulario) → misma página', async () => {
    seed({ paymentId: 'pay-1', status: 'authorized' });
    const res = await request(app).post(checkoutResult.resultPath('pay-1', 'ok')).type('form').send({ order_uuid: 'X' });
    expect(res.status).toBe(200);
    expect(runtimeOf(res.text).result).toBe('succeeded');
  });
});

describe('GET /checkout/result/:paymentId/status — consulta de estado', () => {
  const app = buildApp();

  test('pendiente → final:false; tras el webhook → final:true con la vuelta a la tienda', async () => {
    seed({ paymentId: 'pay-1', status: 'pending_3ds', returnUrl: 'https://tienda.test/vuelta' });
    const path = checkoutResult.statusPath('pay-1');

    let res = await request(app).get(path);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({ success: true, paymentId: 'pay-1', status: 'pending_3ds', result: 'pending', final: false });

    mockTxs.get('pay-1').status = 'authorized';
    res = await request(app).get(path);
    expect(res.body).toMatchObject({ status: 'authorized', result: 'succeeded', final: true });
    expect(new URL(res.body.returnUrl).searchParams.get('result')).toBe('succeeded');
  });

  test('con la firma de la PÁGINA → 403 (firmas separadas)', async () => {
    seed({ paymentId: 'pay-1', status: 'authorized' });
    const page = new URL(checkoutResult.resultPath('pay-1', 'ok'), 'https://x.test');
    const res = await request(app).get(`/checkout/result/pay-1/status${page.search}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('invalid_signature');
  });

  test('caducada → 410; pago inexistente → 404', async () => {
    seed({ paymentId: 'pay-1', status: 'authorized' });
    const old = checkoutResult.statusPath('pay-1', Date.now() - checkoutResult.STATUS_TTL_MS - 1000);
    expect((await request(app).get(old)).status).toBe(410);
    mockTxs.clear();
    expect((await request(app).get(checkoutResult.statusPath('pay-1'))).status).toBe(404);
  });
});
