// tests/unit/checkoutResult.test.js
'use strict';
//
// URLs firmadas de la página de resultado del checkout (utils/checkoutResult):
// firma, caducidad, separación página/estado, lectura tolerante de la query y
// el resultado que se enseña al comprador y se comunica a la web del comercio.

const checkoutResult = require('../../src/utils/checkoutResult');

function queryOf(path) {
  return Object.fromEntries(new URL(path, 'https://x.test').searchParams);
}

describe('checkoutResult — enlaces firmados', () => {
  const NOW = 1790000000000;

  test('resultPath → verifyPage acepta el enlace y devuelve el outcome', () => {
    const q = queryOf(checkoutResult.resultPath('pay-1', 'ok', NOW));
    expect(checkoutResult.verifyPage('pay-1', q, NOW + 1000)).toEqual({ ok: true, outcome: 'ok' });
    const k = queryOf(checkoutResult.resultPath('pay-1', 'ko', NOW));
    expect(checkoutResult.verifyPage('pay-1', k, NOW + 1000)).toEqual({ ok: true, outcome: 'ko' });
  });

  test('otro paymentId con la misma firma → invalid', () => {
    const q = queryOf(checkoutResult.resultPath('pay-1', 'ok', NOW));
    expect(checkoutResult.verifyPage('pay-2', q, NOW)).toEqual({ ok: false, reason: 'invalid' });
  });

  test('cambiar ok ↔ ko en la URL invalida la firma', () => {
    const q = queryOf(checkoutResult.resultPath('pay-1', 'ko', NOW));
    q.outcome = 'ok';
    expect(checkoutResult.verifyPage('pay-1', q, NOW)).toEqual({ ok: false, reason: 'invalid' });
  });

  test('alargar la caducidad invalida la firma', () => {
    const q = queryOf(checkoutResult.resultPath('pay-1', 'ok', NOW));
    q.exp = String(Number(q.exp) + 86400000);
    expect(checkoutResult.verifyPage('pay-1', q, NOW)).toEqual({ ok: false, reason: 'invalid' });
  });

  test('caducado (24 h) → expired', () => {
    const q = queryOf(checkoutResult.resultPath('pay-1', 'ok', NOW));
    const later = NOW + checkoutResult.RESULT_TTL_MS + 1;
    expect(checkoutResult.verifyPage('pay-1', q, later)).toEqual({ ok: false, reason: 'expired' });
  });

  test('sin parámetros o con basura → invalid', () => {
    expect(checkoutResult.verifyPage('pay-1', {}, NOW).ok).toBe(false);
    expect(checkoutResult.verifyPage('pay-1', { outcome: 'ok', exp: 'abc', sig: 'zz' }, NOW).ok).toBe(false);
    expect(checkoutResult.verifyPage('', queryOf(checkoutResult.resultPath('pay-1', 'ok', NOW)), NOW).ok).toBe(false);
  });

  test('la pasarela pega "?x=y" al final → se sigue aceptando (sig va la última)', () => {
    const path = checkoutResult.resultPath('pay-1', 'ok', NOW) + '?order_uuid=ABC';
    expect(checkoutResult.verifyPage('pay-1', queryOf(path), NOW)).toEqual({ ok: true, outcome: 'ok' });
    const amp = checkoutResult.resultPath('pay-1', 'ok', NOW) + '&order_uuid=ABC';
    expect(checkoutResult.verifyPage('pay-1', queryOf(amp), NOW)).toEqual({ ok: true, outcome: 'ok' });
  });

  test('la firma de la página NO vale para la consulta de estado, ni al revés', () => {
    const page = queryOf(checkoutResult.resultPath('pay-1', 'ok', NOW));
    expect(checkoutResult.verifyStatus('pay-1', page, NOW)).toEqual({ ok: false, reason: 'invalid' });
    const status = queryOf(checkoutResult.statusPath('pay-1', NOW));
    expect(checkoutResult.verifyStatus('pay-1', status, NOW)).toEqual({ ok: true });
    expect(checkoutResult.verifyPage('pay-1', { ...status, outcome: 'ok' }, NOW).ok).toBe(false);
  });

  test('la consulta de estado caduca en 1 h', () => {
    const status = queryOf(checkoutResult.statusPath('pay-1', NOW));
    const later = NOW + checkoutResult.STATUS_TTL_MS + 1;
    expect(checkoutResult.verifyStatus('pay-1', status, later)).toEqual({ ok: false, reason: 'expired' });
  });

  test('resultUrl es absoluta y apunta a la página de resultado', () => {
    const url = new URL(checkoutResult.resultUrl('pay-1', 'ok', NOW));
    expect(url.protocol).toBe('https:');
    expect(url.pathname).toBe('/checkout/result/pay-1');
  });
});

describe('checkoutResult — resultado y vuelta a la tienda', () => {
  test('resultOf: aprobados → succeeded, fallidos/cancelados → failed, resto → pending', () => {
    for (const s of ['authorized', 'approved', 'captured', 'partially_captured', 'refunded', 'partially_refunded']) {
      expect(checkoutResult.resultOf(s)).toBe('succeeded');
    }
    for (const s of ['declined', 'refused', 'failed', 'error', 'expired', 'cancelled']) {
      expect(checkoutResult.resultOf(s)).toBe('failed');
    }
    for (const s of ['initialized', 'hosted_pending', 'pending', 'processing', 'pending_3ds', undefined]) {
      expect(checkoutResult.resultOf(s)).toBe('pending');
    }
  });

  test('buildReturnUrl añade paymentId y result conservando la query del comercio', () => {
    const u = new URL(checkoutResult.buildReturnUrl('https://tienda.test/vuelta?pedido=77', 'pay-1', 'succeeded'));
    expect(u.origin).toBe('https://tienda.test');
    expect(u.searchParams.get('pedido')).toBe('77');
    expect(u.searchParams.get('paymentId')).toBe('pay-1');
    expect(u.searchParams.get('result')).toBe('succeeded');
  });

  test('buildReturnUrl rechaza lo que no sea http(s) o lleve credenciales', () => {
    expect(checkoutResult.buildReturnUrl('javascript:alert(1)', 'p', 'failed')).toBeNull();
    expect(checkoutResult.buildReturnUrl('data:text/html,hi', 'p', 'failed')).toBeNull();
    expect(checkoutResult.buildReturnUrl('https://user:pw@tienda.test/', 'p', 'failed')).toBeNull();
    expect(checkoutResult.buildReturnUrl('no es una url', 'p', 'failed')).toBeNull();
    expect(checkoutResult.buildReturnUrl(null, 'p', 'failed')).toBeNull();
    expect(checkoutResult.buildReturnUrl('http://localhost:3000/ok', 'p', 'failed')).toContain('result=failed');
  });
});
