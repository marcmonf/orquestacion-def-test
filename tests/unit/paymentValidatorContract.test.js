// tests/unit/paymentValidatorContract.test.js
'use strict';

/**
 * Dos deudas del DEV-LOG §5, cerradas el 4 ago 2026:
 *
 * 1. Contrato incoherente capture vs refund: `captureSchema` usaba `amount`
 *    plano mientras `refundSchema` y `cancelSchema` usaban
 *    `amountOfMoney: { amount, currencyCode }`. Mismo concepto, dos formas, en
 *    endpoints hermanos. Ahora capture acepta la forma canónica y mantiene la
 *    legada.
 *
 * 2. La trampa del `.validate` machacado: el módulo hacía
 *    `module.exports = paymentSchema` y acto seguido
 *    `module.exports.validate = validate`, sobrescribiéndole a la instancia de
 *    Joi su propio método. `paymentSchema.validate(obj)` devolvía una función
 *    y `{ error }` era SIEMPRE undefined — no rechazaba nada, en silencio.
 */

const validator = require('../../src/validators/paymentValidator');
const { captureSchema, refundSchema, cancelSchema, paymentSchema, validate } = validator;

describe('captureSchema — importe en las dos grafías', () => {
  test('acepta la forma canónica amountOfMoney', () => {
    const { error } = captureSchema.validate({ amountOfMoney: { amount: 1000, currencyCode: 'EUR' } });
    expect(error).toBeUndefined();
  });

  test('sigue aceptando la forma legada amount plano', () => {
    const { error } = captureSchema.validate({ amount: 1000 });
    expect(error).toBeUndefined();
  });

  test('acepta body vacío (captura el importe pendiente completo)', () => {
    const { error } = captureSchema.validate({});
    expect(error).toBeUndefined();
  });

  test('rechaza importes no enteros o negativos en ambas grafías', () => {
    expect(captureSchema.validate({ amount: -5 }).error).toBeDefined();
    expect(captureSchema.validate({ amount: 10.5 }).error).toBeDefined();
    expect(captureSchema.validate({ amountOfMoney: { amount: -5 } }).error).toBeDefined();
    expect(captureSchema.validate({ amountOfMoney: { amount: 10.5 } }).error).toBeDefined();
  });

  test('sigue rechazando campos desconocidos (allowUnknown: false)', () => {
    expect(captureSchema.validate({ cardNumber: '4018810000100036' }).error).toBeDefined();
  });

  test('capture y refund comparten ya la misma forma canónica', () => {
    const body = { amountOfMoney: { amount: 2500, currencyCode: 'EUR' } };
    expect(captureSchema.validate(body).error).toBeUndefined();
    expect(refundSchema.validate(body).error).toBeUndefined();
    expect(cancelSchema.validate(body).error).toBeUndefined();
  });
});

describe('paymentValidator — la trampa del .validate retirada', () => {
  test('exporta un objeto plano, no el schema de Joi mutado', () => {
    expect(typeof validate).toBe('function');
    expect(validator.captureSchema).toBeDefined();
    expect(validator.refundSchema).toBeDefined();
    expect(validator.cancelSchema).toBeDefined();
  });

  test('paymentSchema.validate vuelve a ser el de Joi y SÍ rechaza', () => {
    const res = paymentSchema.validate({});
    // Con la trampa armada esto devolvía una función y error era undefined.
    expect(typeof res).toBe('object');
    expect(res.error).toBeDefined();
  });

  test('paymentSchema.validate acepta un payload válido', () => {
    const { error } = paymentSchema.validate({
      paymentId: 'p1',
      merchantId: 'demo-merchant',
      amount: 1000,
      currency: 'EUR',
      method: 'card',
    });
    expect(error).toBeUndefined();
  });

  test('validate(schema) devuelve middleware que responde 400 y no llama a next', () => {
    const mw = validate(captureSchema);
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    mw({ body: { amount: -1 } }, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  test('validate(schema) llama a next con un body válido', () => {
    const mw = validate(captureSchema);
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    mw({ body: { amountOfMoney: { amount: 100 } } }, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});
