// tests/helpers/lifecycleModels.js
'use strict';
//
// Transaction + Operation en memoria con la semántica que necesita
// paymentLifecycleService ($or / $lt / $exists para el bloqueo por pago, índice
// único paymentId+type+idempotencyKey en Operation, doc con save()).
// Mismo mini motor que tests/unit/paymentLifecycle.test.js, extraído para
// poder reutilizarlo (p. ej. el conector de prueba "B" pasando por el núcleo).
//
// Uso:  jest.mock('../../src/models/Transaction', () => require('../helpers/lifecycleModels').Transaction);
//       jest.mock('../../src/models/Operation',   () => require('../helpers/lifecycleModels').Operation);

function matchValue(docVal, cond) {
  if (cond && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond)) {
    return Object.entries(cond).every(([op, v]) => {
      switch (op) {
        case '$lt':     return docVal != null && docVal < v;
        case '$lte':    return docVal != null && docVal <= v;
        case '$gt':     return docVal != null && docVal > v;
        case '$gte':    return docVal != null && docVal >= v;
        case '$in':     return v.includes(docVal);
        case '$nin':    return !v.includes(docVal);
        case '$ne':     return docVal !== v;
        case '$exists': return v ? docVal !== undefined : docVal === undefined;
        default:        return false;
      }
    });
  }
  if (cond === null) return docVal === null || docVal === undefined;
  return docVal === cond;
}
function matches(doc, filter) {
  return Object.entries(filter || {}).every(([k, v]) => {
    if (k === '$or') return v.some((f) => matches(doc, f));
    return matchValue(doc[k], v);
  });
}

const txStore = [];
const opStore = [];
let opSeq = 1;

function txDoc(data) {
  const doc = { ...data };
  Object.defineProperty(doc, 'save', {
    value: async function () {
      const i = txStore.findIndex((t) => t.paymentId === this.paymentId);
      const plain = { ...this };
      if (i >= 0) txStore[i] = plain; else txStore.push(plain);
      return this;
    },
    enumerable: false,
  });
  return doc;
}

const Transaction = {
  __store: txStore,
  __reset() { txStore.length = 0; },
  async create(data) { if (txStore.some((t) => t.paymentId === data.paymentId)) { const e = new Error('E11000'); e.code = 11000; throw e; } txStore.push({ ...data }); return txDoc(data); },
  findOne(filter) {
    const d = txStore.find((t) => matches(t, filter));
    return {
      lean: async () => (d ? { ...d } : null),
      then: (res, rej) => Promise.resolve(d ? txDoc(d) : null).then(res, rej),
    };
  },
  async findOneAndUpdate(filter, update) {
    const d = txStore.find((t) => matches(t, filter));
    if (!d) return null;
    Object.assign(d, update.$set || {});
    return txDoc(d);
  },
  async updateOne(filter, update) {
    const d = txStore.find((t) => matches(t, filter));
    if (d) Object.assign(d, update.$set || {});
    return { modifiedCount: d ? 1 : 0 };
  },
};

const Operation = {
  __store: opStore,
  __reset() { opStore.length = 0; },
  async create(data) {
    const dup = opStore.find((o) => o.paymentId === data.paymentId && o.type === data.type && o.idempotencyKey === data.idempotencyKey);
    if (dup) { const e = new Error('E11000 duplicate key'); e.code = 11000; throw e; }
    const doc = { _id: String(opSeq++), ...data };
    opStore.push(doc);
    return doc;
  },
  findOne(filter) { return { lean: async () => { const d = opStore.find((o) => matches(o, filter)); return d ? { ...d } : null; } }; },
  find(filter) { return { lean: async () => opStore.filter((o) => matches(o, filter)).map((o) => ({ ...o })) }; },
  async updateOne(filter, update) {
    const d = opStore.find((o) => matches(o, filter));
    if (d) Object.assign(d, update.$set || {});
    return { modifiedCount: d ? 1 : 0 };
  },
  async deleteOne(filter) {
    const i = opStore.findIndex((o) => matches(o, filter));
    if (i >= 0) opStore.splice(i, 1);
    return { deletedCount: i >= 0 ? 1 : 0 };
  },
};

module.exports = { Transaction, Operation, matches };
