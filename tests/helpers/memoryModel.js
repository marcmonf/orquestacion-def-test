// tests/helpers/memoryModel.js
'use strict';
//
// Modelo Mongoose MÍNIMO en memoria para tests, fiel a las operaciones que usan
// las rutas del portal. Permite probar el AISLAMIENTO de verdad, en caja negra:
// se siembran usuarios de A y B, y una query {_id, merchantId} que no casa
// devuelve null → la ruta responde 404. No depende de mongodb-memory-server (que
// no está disponible en este entorno — ver DEV-LOG §5, los 9 fallos preexistentes
// de webhooks.test.js son justamente por eso).
//
// Soporta lo que el código real invoca:
//   create(data) · findOne(query) · findById(id) · countDocuments(query)
//   find(query).select().sort().lean()  (y find(query) awaitable)
// El matcher entiende igualdad y los operadores $ne / $in.
//
let _seq = 1;

function matches(doc, query) {
  return Object.entries(query || {}).every(([k, v]) => {
    // Objeto de operadores ({ $gte, $lt, $in, ... }) — pero NO una Date (también es objeto).
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
      return Object.entries(v).every(([op, operand]) => {
        switch (op) {
          case '$ne':  return doc[k] !== operand;
          case '$in':  return Array.isArray(operand) && operand.includes(doc[k]);
          case '$nin': return Array.isArray(operand) && !operand.includes(doc[k]);
          case '$gte': return doc[k] >= operand;
          case '$lte': return doc[k] <= operand;
          case '$gt':  return doc[k] >  operand;
          case '$lt':  return doc[k] <  operand;
          default:     return doc[k] === v;   // operador desconocido → igualdad literal
        }
      });
    }
    return doc[k] === v;
  });
}

function attachSave(doc, store) {
  Object.defineProperty(doc, 'save', {
    value: async function () {
      this.updatedAt = new Date();
      if (!store.includes(this)) store.push(this);
      return this;
    },
    enumerable: false, writable: true, configurable: true,
  });
  return doc;
}

module.exports = function makeMemoryModel() {
  const store = [];

  function queryResult(rows) {
    let _skip = 0, _limit = null;
    function materialize() {
      let out = rows.slice(_skip);
      if (_limit != null) out = out.slice(0, _limit);
      return out.map(r => ({ ...r }));
    }
    const q = {
      select() { return q; },
      sort()   { return q; },
      skip(n)  { _skip = parseInt(n) || 0; return q; },
      limit(n) { _limit = (n == null ? null : parseInt(n)); return q; },
      lean()   { return Promise.resolve(materialize()); },
      then(resolve, reject) { return Promise.resolve(materialize()).then(resolve, reject); },
    };
    return q;
  }

  return {
    __store: store,
    __reset() { store.length = 0; },

    async create(data) {
      const doc = attachSave(
        { _id: String(_seq++), createdAt: new Date(), updatedAt: new Date(), ...data },
        store
      );
      store.push(doc);
      return doc;
    },

    // findOne admite dos usos, como en Mongoose:
    //   - `await Model.findOne(q)`      → doc REAL (con .save())
    //   - `await Model.findOne(q).lean()` → copia plana (solo lectura)
    findOne(query = {}) {
      const doc = store.find(d => matches(d, query)) || null;
      const thenable = {
        select() { return thenable; },
        lean()   { return Promise.resolve(doc ? { ...doc } : null); },
        then(resolve, reject) { return Promise.resolve(doc).then(resolve, reject); },
      };
      return thenable;
    },

    async findById(id) {
      return store.find(d => d._id === String(id)) || null;
    },

    find(query = {}) {
      return queryResult(store.filter(d => matches(d, query)));
    },

    async countDocuments(query = {}) {
      return store.filter(d => matches(d, query)).length;
    },

    async deleteOne(query = {}) {
      const idx = store.findIndex(d => matches(d, query));
      if (idx === -1) return { deletedCount: 0 };
      store.splice(idx, 1);
      return { deletedCount: 1 };
    },

    async deleteMany(query = {}) {
      const before = store.length;
      for (let i = store.length - 1; i >= 0; i--) { if (matches(store[i], query)) store.splice(i, 1); }
      return { deletedCount: before - store.length };
    },

    // findOneAndUpdate MÍNIMO: soporta $set, $setOnInsert, $inc y upsert (lo que
    // usan la numeración correlativa y markSent). Devuelve el doc (new:true).
    async findOneAndUpdate(query = {}, update = {}, opts = {}) {
      let doc = store.find(d => matches(d, query));
      if (!doc) {
        if (!opts.upsert) return null;
        doc = attachSave({ _id: String(_seq++), createdAt: new Date(), updatedAt: new Date() }, store);
        Object.entries(query).forEach(([k, v]) => { if (v == null || typeof v !== 'object') doc[k] = v; });
        if (update.$setOnInsert) Object.assign(doc, update.$setOnInsert);
        store.push(doc);
      }
      const hasOps = Object.keys(update).some(k => k.startsWith('$'));
      const set = update.$set || (hasOps ? {} : update);
      Object.assign(doc, set);
      if (update.$inc) Object.entries(update.$inc).forEach(([k, n]) => { doc[k] = (Number(doc[k]) || 0) + n; });
      doc.updatedAt = new Date();
      return { ...doc };
    },

    // aggregate MÍNIMO: soporta $match y $group con _id:null y acumuladores
    // $sum/$avg sobre un campo (lo que usan las analíticas del portal).
    async aggregate(pipeline = []) {
      let rows = store.slice();
      for (const stage of pipeline) {
        if (stage.$match) {
          rows = rows.filter(d => matches(d, stage.$match));
        } else if (stage.$group) {
          const acc = { _id: null };
          for (const [k, spec] of Object.entries(stage.$group)) {
            if (k === '_id') continue;
            if (spec && spec.$sum) {
              const f = String(spec.$sum).replace(/^\$/, '');
              acc[k] = rows.reduce((s, d) => s + (Number(d[f]) || 0), 0);
            } else if (spec && spec.$avg) {
              const f = String(spec.$avg).replace(/^\$/, '');
              acc[k] = rows.length ? rows.reduce((s, d) => s + (Number(d[f]) || 0), 0) / rows.length : 0;
            }
          }
          rows = [acc];
        }
      }
      return rows;
    },
  };
};
