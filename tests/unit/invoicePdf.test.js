// tests/unit/invoicePdf.test.js
'use strict';
//
// Humo del PDF de factura (M7 Bloque 1): produce un PDF válido y no vacío.
//
const { renderInvoicePdf } = require('../../src/services/invoicePdf');

test('renderInvoicePdf produce un PDF válido', async () => {
  const inv = {
    invoiceNumber: 'A-2026-0001', period: '2026-05', currency: 'EUR',
    issuer: { legalName: 'Monetiser SL', taxId: 'B00000000', address: { street: 'Calle 1', city: 'Las Palmas', province: 'Las Palmas', country: 'ES' }, email: 'facturacion@monetiser.com', iban: 'ES00...' },
    recipient: { legalName: 'Comercio Demo SL', taxId: 'B11111111', merchantId: 'demo', city: 'Madrid' },
    lines: [{ label: 'Mantenimiento mensual', amount: 5000 }, { label: 'Transacciones (120)', amount: 1800 }],
    subtotal: 6800, taxLabel: 'IGIC general', taxPercent: 7, taxAmount: 476, total: 7276,
    taxNote: '', finalizedAt: new Date(Date.UTC(2026, 5, 1)),
  };
  const buf = await renderInvoicePdf(inv);
  expect(Buffer.isBuffer(buf)).toBe(true);
  expect(buf.slice(0, 5).toString('latin1')).toBe('%PDF-');
  expect(buf.length).toBeGreaterThan(800);
});
