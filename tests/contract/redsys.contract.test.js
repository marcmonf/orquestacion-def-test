// tests/contract/redsys.contract.test.js
'use strict';
// Redsys directo (6 nov 2026): la MISMA suite de contrato que Paylands y Stripe,
// más la firma HMAC_SHA256_V1 y la regla PCI (nunca datos de tarjeta).
// Clave de pruebas INVENTADA (no es la del comercio de pruebas de Redsys).

jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn() }));

const crypto = require('crypto');
const provider = require('../../src/connectors/redsys');
const sig = require('../../src/connectors/redsys/signature');
const { runConnectorContract } = require('./connectorContract');

const KEY = Buffer.from('0123456789abcdefghijklmn').toString('base64'); // 24 bytes inventados
const ctx = { credentials: { merchantCode: '123456789', terminal: '1', secretKey: KEY } };
const base = { paymentId: 'pay-r1', merchantId: 'm1', amount: 2500, currency: 'EUR', method: 'card', merchantUrl: 'https://monetiser.invalid/webhooks/redsys/m1', urlOk: 'https://monetiser.invalid/ok', urlKo: 'https://monetiser.invalid/ko' };

function notification(params, key = KEY) {
  const Ds_MerchantParameters = sig.encodeParams(params);
  return { Ds_SignatureVersion: 'HMAC_SHA256_V1', Ds_MerchantParameters, Ds_Signature: sig.sign(key, params.Ds_Order, Ds_MerchantParameters) };
}

runConnectorContract({
  provider,
  harness: {
    ctx,
    payment(kind) {
      if (kind === 'requires_action') return { ...base };
      if (kind === 'technical_error') return { ...base, currency: 'USD' }; // divisa sin código verificado → error, nunca rechazo
      return null; // aprobación y rechazo llegan por la notificación, no en la creación
    },
    lifecycle: {
      // Canal de operaciones sin titular APAGADO: no hay casos de éxito.
      refundWithoutCapture: { input: { processorReference: '1234ABCD' } },
    },
    webhook() {
      const valid = notification({ Ds_Order: '1234ABCDEFGH', Ds_Response: '0000', Ds_TransactionType: '1', Ds_Amount: '2500', Ds_MerchantData: 'pay-r1' });
      const tampered = { ...valid, Ds_MerchantParameters: sig.encodeParams({ Ds_Order: '1234ABCDEFGH', Ds_Response: '0000', Ds_TransactionType: '1', Ds_Amount: '1' }) };
      return { ctx, valid: { body: valid, headers: {}, rawBody: '' }, tampered: { body: tampered, headers: {}, rawBody: '' } };
    },
    rawStatuses: ['0000', '0099', '0190', '9999', '1:0000', '2:900', '9:400', '3:900'],
  },
});

describe('Redsys — firma HMAC_SHA256_V1 (algoritmo del manual de redirección)', () => {
  test('paso a paso, calculado aparte en el test: Base64 → 3DES del pedido → HMAC-SHA256 → Base64', () => {
    const order = '1234ABCDEFGH';
    const params = sig.encodeParams({ Ds_Merchant_Order: order, Ds_Merchant_Amount: '2500' });
    // 3DES (CBC, IV de ceros, relleno con ceros: PENDIENTE DE VERIFICAR contra Redsys real).
    const c = crypto.createCipheriv('des-ede3-cbc', Buffer.from(KEY, 'base64'), Buffer.alloc(8));
    c.setAutoPadding(false);
    const padded = Buffer.concat([Buffer.from(order), Buffer.alloc((8 - (order.length % 8)) % 8)]);
    const opKey = Buffer.concat([c.update(padded), c.final()]);
    const expected = crypto.createHmac('sha256', opKey).update(params).digest('base64');
    expect(sig.sign(KEY, order, params)).toBe(expected);
    expect(sig.operationKey(KEY, order).length).toBe(16);
  });

  test('la clave de la operación depende del pedido (dos pedidos → dos firmas)', () => {
    const p = sig.encodeParams({ a: 1 });
    expect(sig.sign(KEY, '1111AAAA', p)).not.toBe(sig.sign(KEY, '2222AAAA', p));
  });

  test('verificación: firma correcta, manipulada, otra clave, Base64 para URL y "+" convertidos en espacios', () => {
    const n = notification({ Ds_Order: '9876XYZ', Ds_Response: '0000' });
    expect(sig.verify(KEY, n).ok).toBe(true);
    expect(sig.verify(KEY, { ...n, Ds_Signature: n.Ds_Signature.replace(/[A-Z]/, 'a') }).ok).toBe(false);
    expect(sig.verify(Buffer.from('nmlkjihgfedcba9876543210').toString('base64'), n).ok).toBe(false);
    expect(sig.verify(KEY, { ...n, Ds_Signature: n.Ds_Signature.replace(/\+/g, '-').replace(/\//g, '_') }).ok).toBe(true);
    expect(sig.verify(KEY, { ...n, Ds_MerchantParameters: n.Ds_MerchantParameters.replace(/\+/g, ' ') }).ok).toBe(true);
    expect(sig.verify(KEY, { ...n, Ds_SignatureVersion: 'OTRA' }).ok).toBe(false);
    expect(() => sig.decodeKey('corta')).toThrow();
  });
});

describe('Redsys — formulario de redirección', () => {
  test('preautorización (tipo 1), campos obligatorios, EUR = 978, firma válida y NINGÚN dato de tarjeta', async () => {
    const r = await provider.createPayment({ ...base, order: '0042abcDEF12' }, ctx);
    expect(r).toMatchObject({ status: 'requires_action', processorReference: '0042abcDEF12', action: { type: 'form_post', url: 'https://sis-t.redsys.es:25443/sis/realizarPago' } });
    expect(Object.keys(r.action.fields).sort()).toEqual(['Ds_MerchantParameters', 'Ds_Signature', 'Ds_SignatureVersion']);
    const p = sig.decodeParams(r.action.fields.Ds_MerchantParameters);
    expect(p).toEqual({
      Ds_Merchant_MerchantCode: '123456789', Ds_Merchant_Terminal: '1', Ds_Merchant_TransactionType: '1',
      Ds_Merchant_Amount: '2500', Ds_Merchant_Currency: '978', Ds_Merchant_Order: '0042abcDEF12',
      Ds_Merchant_MerchantURL: base.merchantUrl, Ds_Merchant_UrlOK: base.urlOk, Ds_Merchant_UrlKO: base.urlKo, Ds_Merchant_MerchantData: 'pay-r1',
    });
    for (const f of provider.extensions.FORBIDDEN_FIELDS) expect(Object.keys(p)).not.toContain(f);
    expect(JSON.stringify(p)).not.toMatch(/Pan|Expiry|CVV/i);
    expect(sig.sign(KEY, '0042abcDEF12', r.action.fields.Ds_MerchantParameters)).toBe(r.action.fields.Ds_Signature);
  });

  test('número de pedido: 12 caracteres, 4 primeros numéricos, resto alfanumérico ASCII', () => {
    for (let i = 0; i < 200; i++) {
      const o = provider.extensions.newOrder();
      expect(o).toMatch(/^[0-9]{4}[A-Za-z0-9]{8}$/);
    }
    expect(provider.extensions.validOrder('12AB')).toBe(false);
    expect(provider.extensions.validOrder('1234')).toBe(true);
    expect(provider.extensions.validOrder('1234567890123')).toBe(false);
  });

  test('con token de tarjeta (S2S) → not_supported; sin credenciales o en live → configuration_error', async () => {
    expect((await provider.createPayment({ ...base, sourceToken: 'x' }, ctx)).error.code).toBe('not_supported');
    expect((await provider.createPayment(base, {})).error.code).toBe('configuration_error');
    expect((await provider.createPayment(base, { ...ctx, livemode: true })).error.code).toBe('configuration_error');
  });

  test('Ds_Response → estados: 0000-0099 autorizado, 9999 en autenticación (no aprobado), resto denegado; 900/400 por tipo', () => {
    const s = provider.extensions.responseStatus;
    expect(s('1', '0000')).toBe('authorized');
    expect(s('1', '0099')).toBe('authorized');
    expect(s('1', '0100')).toBe('declined');
    expect(s('1', '9999')).toBe('pending_3ds');
    expect(s('0', '0000')).toBe('captured');
    expect(s('2', '900')).toBe('captured');
    expect(s('3', '900')).toBe('refunded');
    expect(s('9', '400')).toBe('cancelled');
    expect(s('9', '900')).toBeNull();
    expect(s('1', 'abc')).toBeNull();
  });

  test('capture / cancel / refund APAGADOS (canal sin verificar) → not_supported sin llamar a nada', async () => {
    for (const op of ['capture', 'cancel', 'refund']) {
      const r = await provider[op]({ processorReference: '1234ABCD', amount: 100 }, ctx);
      expect(r.success).toBe(false);
      expect(r.error.code).toBe('not_supported');
    }
  });

  test('validación de credenciales de /admin', () => {
    const v = provider.extensions.validateCredentials;
    expect(v({ merchantCode: '123456789', terminal: '1', secretKey: KEY }, 'test')).toBeNull();
    expect(v({ merchantCode: '12345', terminal: '1', secretKey: KEY }, 'test')).toMatch(/9 números/);
    expect(v({ merchantCode: '123456789', terminal: '1234', secretKey: KEY }, 'test')).toMatch(/terminal/);
    expect(v({ merchantCode: '123456789', terminal: '1', secretKey: 'abc' }, 'test')).toMatch(/secretKey/);
    expect(v({ merchantCode: '123456789', terminal: '1', secretKey: KEY }, 'live')).toMatch(/PRUEBAS/);
  });
});
