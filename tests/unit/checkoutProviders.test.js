// tests/unit/checkoutProviders.test.js
'use strict';
//
// F3 multi-PSP: el checkout elige el proveedor de campos del conector enrutado.
// Para Paylands todo debe quedar EXACTAMENTE como antes (CSP, runtime, flujo).

const fs = require('fs');
const path = require('path');
jest.mock('../../src/models/TraceLog', () => ({ TraceLog: null, isEnabled: false }));

const cp = require('../../src/utils/checkoutProviders');
const { _test: iframe } = require('../../src/routes/iframe');

// CSP literal del iFrame ANTES del framework (src/routes/iframe.js en 614e5df).
const CSP_BEFORE =
  "default-src 'self'; " +
  "img-src 'self' data: https:; " +
  "style-src 'self' 'unsafe-inline'; " +
  "script-src 'self' 'unsafe-inline' https://pci-proxy-api.paynopain.com; " +
  "connect-src 'self' https://pci-proxy-api.paynopain.com; " +
  "frame-src 'self' https://pci-proxy-api.paynopain.com https://pci-proxy-sandbox.paynopain.com https://api.paylands.com; " +
  "form-action 'self' https://api.paylands.com; " +
  "base-uri 'none'; object-src 'none'; " +
  'frame-ancestors *;';

describe('Proveedores de campos del checkout', () => {
  test('CSP de Paylands idéntica a la de antes del framework', () => {
    expect(cp.buildCsp(cp.PROVIDERS.paylands_proxyfields)).toBe(CSP_BEFORE);
    expect(iframe.CSP_HEADER).toBe(CSP_BEFORE);
  });

  test('pago sin routing (anterior al framework) → Paylands; con routing → su proveedor', () => {
    expect(iframe.fieldsProviderFor({}).id).toBe('paylands_proxyfields');
    expect(iframe.fieldsProviderFor({ routing: { fieldsProvider: 'paylands_proxyfields' } }).id).toBe('paylands_proxyfields');
    expect(iframe.fieldsProviderFor({ routing: { fieldsProvider: 'no_existe' } })).toBeNull();
  });

  test('métodos ofrecidos: solo los que el checkout sabe presentar (hoy tarjeta)', () => {
    expect(iframe.paymentMethodsFor({})).toEqual(['card']);
    expect(iframe.paymentMethodsFor({ routing: { connector: 'conector-retirado' } })).toEqual(['card']);
  });

  test('runtime inyectado: añade proveedor y métodos sin quitar nada de lo anterior', () => {
    const html = iframe.injectRuntime('<html><head></head><body></body></html>', {}, { paymentId: 'p', merchantId: 'm', amount: '1.00', currency: 'EUR' });
    const json = JSON.parse(html.match(/__MONETISER_RUNTIME__ = (\{.*\});/)[1]);
    expect(json).toMatchObject({
      paymentId: 'p', merchantId: 'm', amount: '1.00', currency: 'EUR',
      pciClientUrl: 'https://pci-proxy-api.paynopain.com/sandbox/client.js',
      fieldsProvider: 'paylands_proxyfields',
      providerScript: '/checkout/providers/paylands_proxyfields.js',
      paymentMethods: ['card'],
    });
  });

  test('cada proveedor tiene su módulo en public/ con ruta ABSOLUTA (CLAUDE.md)', () => {
    for (const p of Object.values(cp.PROVIDERS)) {
      expect(p.script.startsWith('/checkout/providers/')).toBe(true);
      expect(fs.existsSync(path.join(__dirname, '../../public', p.script))).toBe(true);
    }
  });

  test('PCI SAQ A: el checkout no tiene ningún campo propio de número de tarjeta ni CVV', () => {
    const html = fs.readFileSync(path.join(__dirname, '../../public/iframe.html'), 'utf8');
    expect(html).not.toMatch(/<input[^>]+(cc-number|cardnumber|card-number|cvv|cvc)/i);
    const prov = fs.readFileSync(path.join(__dirname, '../../public/checkout/providers/paylands_proxyfields.js'), 'utf8');
    // Al servidor de Monetiser solo viaja el paymentId (nunca datos de tarjeta).
    expect(prov).toMatch(/proxy-pci\/charge[\s\S]*body: JSON\.stringify\(\{ paymentId \}\)/);
  });
});
