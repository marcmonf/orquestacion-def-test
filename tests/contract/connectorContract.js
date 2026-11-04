// tests/contract/connectorContract.js
'use strict';
//
// SUITE DE CONTRATO QUE TODO CONECTOR PSP DEBE PASAR (framework multi-PSP).
//
// Uso (un fichero *.contract.test.js por conector):
//
//   const { runConnectorContract } = require('./connectorContract');
//   runConnectorContract({ provider, harness });
//
// harness: cómo provocar cada caso en ESE conector (simulando su red, nunca
// llamando al PSP de verdad):
//   ctx                         contexto de credenciales para las operaciones
//   payment(kind) → input|null  input de createPayment para kind =
//                               'approve' | 'requires_action' | 'decline' | 'technical_error'
//                               (null = el PSP no tiene ese camino; se omite)
//   prepare(kind)  (opcional)   prepara la red simulada para ese caso
//   lifecycle: { captureOk, cancelOk, refundOk, refundWithoutCapture } → { input, prepare? }
//   webhook()  (si declara webhooks) → { valid:{body,headers,rawBody}, tampered:{...}, ctx }
//   rawStatuses                 estados crudos del PSP que mapStatus debe reconocer
//
// Qué comprueba:
//   - definición: todas las operaciones existen; capacidades coherentes
//   - createPayment: resultados normalizados (checkPaymentResult), errores de la taxonomía
//   - timeout/errores técnicos → status 'error' (nunca 'declined': no es un rechazo)
//   - capture/cancel/refund: success true, o error normalizable
//   - mapStatus: solo estados de Monetiser; desconocido → null
//   - normalizeError: siempre un código de la taxonomía
//   - webhooks: firma válida → true; manipulada → false; parse con processorReference
//   - PCI SAQ A: ningún input ni output contiene algo con forma de PAN
//   - adaptador legado (legacyFromProvider) usable por el núcleo

const {
  OPERATIONS, MONETISER_STATUSES, PAYMENT_METHODS, checkPaymentResult, checkError, supports,
} = require('../../src/connectors/contract');
const { isErrorCode } = require('../../src/connectors/errors');
const { legacyFromProvider } = require('../../src/services/connectorRegistry');

// ¿Hay en el texto una secuencia de 13-19 dígitos que pase Luhn? (forma de PAN)
function containsPanLike(text) {
  const runs = String(text).match(/\d{13,19}/g) || [];
  return runs.some((digits) => {
    let sum = 0; let dbl = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let d = Number(digits[i]);
      if (dbl) { d *= 2; if (d > 9) d -= 9; }
      sum += d; dbl = !dbl;
    }
    return sum % 10 === 0;
  });
}

function runConnectorContract({ provider, harness }) {
  const caps = provider.capabilities;
  const seen = [];
  const remember = (x) => { seen.push(JSON.stringify(x === undefined ? null : x)); return x; };

  describe(`Contrato de conector — ${provider.id}`, () => {
    describe('definición', () => {
      test('expone todas las operaciones del contrato como funciones', () => {
        for (const op of OPERATIONS) expect(typeof provider[op]).toBe('function');
      });
      test('capacidades coherentes', () => {
        expect(caps.paymentMethods.length).toBeGreaterThan(0);
        for (const m of caps.paymentMethods) expect(PAYMENT_METHODS).toContain(m);
        for (const c of caps.currencies) expect(c).toMatch(/^[A-Z]{3}$/);
        if (caps.partialCapture) expect(caps.deferredCapture).toBe(true);
        if (caps.partialRefund) expect(caps.refund).toBe(true);
        expect(Array.isArray(caps.credentialFields)).toBe(true);
        expect(Object.isFrozen(provider)).toBe(true);
      });
      test('supports(): acepta lo declarado y rechaza lo no declarado', () => {
        expect(supports(provider, { method: caps.paymentMethods[0], currency: caps.currencies[0] }).ok).toBe(true);
        expect(supports(provider, { method: 'card', currency: 'XXX' }).ok).toBe(false);
      });
    });

    describe('createPayment', () => {
      for (const kind of ['approve', 'requires_action', 'decline', 'technical_error']) {
        test(`caso ${kind}: resultado normalizado`, async () => {
          const input = harness.payment(kind);
          if (!input) return; // camino inexistente en este PSP
          if (harness.prepare) await harness.prepare(kind);
          remember(input);
          const r = remember(await provider.createPayment(input, harness.ctx));
          expect(checkPaymentResult(r)).toEqual([]);
          if (kind === 'approve') expect(['authorized', 'captured']).toContain(r.status);
          if (kind === 'requires_action') expect(r.status).toBe('requires_action');
          if (kind === 'decline') expect(r.status).toBe('declined');
          // Un fallo técnico NUNCA es un rechazo del banco (y nunca autoriza).
          if (kind === 'technical_error') {
            expect(r.status).toBe('error');
            expect(checkError(r.error)).toBe(true);
          }
        });
      }
    });

    describe('ciclo de vida', () => {
      const L = harness.lifecycle || {};
      for (const [name, op] of [['captureOk', 'capture'], ['cancelOk', 'cancel'], ['refundOk', 'refund']]) {
        test(`${op}: éxito con la forma esperada`, async () => {
          if (!L[name]) return;
          if (L[name].prepare) await L[name].prepare();
          const r = remember(await provider[op](remember(L[name].input), harness.ctx));
          expect(r.success).toBe(true);
          if (op === 'capture' && r.capturedTotal !== undefined && r.capturedTotal !== null) expect(Number.isFinite(Number(r.capturedTotal))).toBe(true);
        });
      }
      test('refund sin captura previa: falla y el error es normalizable', async () => {
        if (!L.refundWithoutCapture) return;
        if (L.refundWithoutCapture.prepare) await L.refundWithoutCapture.prepare();
        const r = remember(await provider.refund(L.refundWithoutCapture.input, harness.ctx));
        expect(r.success).toBe(false);
        const err = r.errorInfo || (r.error && r.error.code ? r.error : provider.normalizeError(r.error));
        expect(isErrorCode(err.code)).toBe(true);
      });
      test('operaciones no declaradas → not_supported', async () => {
        if (!caps.retrieve) {
          const r = await provider.retrieve({ processorReference: 'x' }, harness.ctx);
          expect(r.success).toBe(false);
          expect(r.error.code).toBe('not_supported');
        }
      });
    });

    describe('estados y errores', () => {
      test('mapStatus: los estados crudos conocidos van a estados de Monetiser', () => {
        for (const raw of harness.rawStatuses || []) {
          const st = provider.mapStatus(raw);
          expect(st === null || MONETISER_STATUSES.includes(st)).toBe(true);
        }
        expect((harness.rawStatuses || []).some((raw) => provider.mapStatus(raw) !== null)).toBe(true);
      });
      test('mapStatus: estado desconocido → null (no inventa)', () => {
        expect(provider.mapStatus('__estado_que_no_existe__')).toBeNull();
        expect(provider.mapStatus(null)).toBeNull();
      });
      test('normalizeError: siempre devuelve un código de la taxonomía', () => {
        for (const raw of [undefined, null, '', 'boom', { foo: 1 }, new Error('x').message]) {
          const e = provider.normalizeError(raw);
          expect(checkError(e)).toBe(true);
        }
      });
    });

    if (caps.webhooks) {
      describe('webhook entrante', () => {
        test('firma válida → true; manipulada → false; parse devuelve la referencia', () => {
          const w = harness.webhook();
          expect(provider.verifyWebhook(w.valid, w.ctx)).toBe(true);
          expect(provider.verifyWebhook(w.tampered, w.ctx)).toBe(false);
          expect(provider.verifyWebhook({ body: {}, headers: {}, rawBody: '{}' }, w.ctx)).toBe(false);
          const parsed = provider.parseWebhook(w.valid.body);
          expect(typeof parsed.processorReference).toBe('string');
          expect(parsed.status === null || MONETISER_STATUSES.includes(parsed.status)).toBe(true);
        });
      });
    }

    describe('núcleo y PCI', () => {
      test('el adaptador legado generado desde el contrato es usable por el núcleo', async () => {
        const legacy = legacyFromProvider(provider);
        for (const fn of ['authorize', 'capture', 'void', 'refund', 'isSoftDecline']) expect(typeof legacy[fn]).toBe('function');
        expect(legacy.isSoftDecline('x')).toBe(false);
      });
      test('PCI SAQ A: ningún input ni output del conector tiene forma de PAN', () => {
        expect(seen.length).toBeGreaterThan(0);
        for (const s of seen) expect(containsPanLike(s)).toBe(false);
      });
    });
  });
}

module.exports = { runConnectorContract, containsPanLike };
