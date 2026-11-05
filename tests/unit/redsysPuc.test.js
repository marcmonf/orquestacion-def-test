// tests/unit/redsysPuc.test.js — armazón PUC de Redsys: apagado y sin protocolo inventado.
'use strict';
const fs = require('fs');
const puc = require('../../src/connectors/redsys/puc');

test('apagado siempre y todas las operaciones → not_supported', async () => {
  process.env.FEATURE_CARD_PRESENT = 'true';
  expect(puc.enabled()).toBe(false);
  delete process.env.FEATURE_CARD_PRESENT;
  for (const op of ['pair', 'startSale', 'cancelSale', 'status']) {
    const r = await puc[op]({ terminalId: 't1', amount: 100 });
    expect(r.success).toBe(false);
    expect(r.error.code).toBe('not_supported');
  }
  expect(puc.MODE).toBe('redsys_puc');
});

test('no contiene mensajes del protocolo (no se inventa la especificación)', () => {
  const src = fs.readFileSync(require.resolve('../../src/connectors/redsys/puc'), 'utf8');
  expect(src).not.toMatch(/https?:\/\//);
  expect(src).not.toMatch(/0x[0-9a-f]{2}/i);
});
