// tests/helpers/memoryModel.js
'use strict';
//
// Modelo Mongoose MÍNIMO en memoria para tests, fiel a las operaciones que usan
// las rutas del portal. Permite probar el AISLAMIENTO de verdad, en caja negra:
// se siembran usuarios de A y B, y una query {_id, merchantId} que no casa
// devuelve null → la ruta responde 404. No depende de mongodb-memory-server, que
// no está disponible en este entorno.
//
// OJO: este comentario afirmaba que los 9 fallos de webhooks.test.js eran "por
// eso" (falta de mongodb-memory-server). Era FALSO — no tenían nada que ver con
// Mongo: el test firmaba mal el webhook. Arreglado 21 ago 2026, ver DEV-LOG.
//
// Soporta lo que el código real invoca:
//   create(data) (con índices únicos opcionales) · findOne(query) · findById(id) · countDocuments(query)
//   find(query).select().sort().lean()  (y find(query) awaitable)
//   findOneAndUpdate / updateOne con $set, $inc (y upsert en el primero)
// El matcher entiende igualdad y los operadores $ne / $in / $nin / $gt(e) / $lt(e) / $regex.
//
let _seq = 1;

// Rutas con punto ('totp.lastUsedStep'), como Mongo: lectura y escritura anidadas.
function getPath(doc, k) {
  if (!k.includes('.')) return doc[k];
  return k.split('.').reduce((o, p) => (o == null ? undefined : o[p]), doc);
}
function applySet(doc, set) {
  for (const [k, v] of Object.entries(set || {})) {
    if (!k.includes('.')) { doc[k] = v; continue; }
    const parts = k.split('.');
    let o = doc;
    for (const p of parts.slice(0, -1)) { if (o[p] == null || typeof o[p] !== 'object') o[p] = {}; o = o[p]; }
    o[parts[parts.length - 1]] = v;
  }
}

function matches(doc, query) {
  return Object.entries(query || {}).every(([k, v0]) => {
    if (k === '$or') return Array.isArray(v0) && v0.some((q) => matches(doc, q));
    const docV = getPath(doc, k);
    const d = k.includes('.') ? { [k]: docV } : doc;
    const v = v0;
    return matchOne(d, k, v);
  });
}

function matchOne(doc, k, v) {
  return (() => {
    // Objeto de operadores ({ $gte, $lt, $in, ... }) — pero NO una Date (también es objeto).
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
      return Object.entries(v).every(([op, operand]) => {
        switch (op) {
          case '$regex': return new RegExp(operand, v.$options || '').test(String(doc[k] == null ? '' : doc[k]));
          case '$options': return true;   // lo consume $regex
          case '$ne':  return doc[k] !== operand;
          case '$type': return operand === 'string' ? typeof doc[k] === 'string' : false;
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
  })();
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

// opts.unique: lista de claves únicas, p. ej. [['invoiceNumber'], ['merchantId', 'period']].
// create() lanza un error E11000 (code 11000) como el índice único de Mongo.
module.exports = function makeMemoryModel(opts = {}) {
  const store = [];
  const uniques = opts.unique || [];

  function assertUnique(data) {
    for (const keys of uniques) {
      if (keys.some(k => data[k] === undefined || data[k] === null)) continue;
      if (store.some(d => keys.every(k => d[k] === data[k]))) {
        const e = new Error(`E11000 duplicate key error dup key: ${JSON.stringify(keys.map(k => data[k]))}`);
        e.code = 11000;
        throw e;
      }
    }
  }

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
      assertUnique(data);
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
      let doc = store.find(d => matches(d, query)) || null;
      const thenable = {
        select() { return thenable; },
        // sort({ campo: 1|-1 }) — elige el primero según ese orden.
        sort(spec) {
          const [k, dir] = Object.entries(spec || {})[0] || [];
          if (k) {
            const rows = store.filter(d => matches(d, query)).sort((a, b) => (a[k] > b[k] ? 1 : a[k] < b[k] ? -1 : 0) * (dir < 0 ? -1 : 1));
            doc = rows[0] || null;
          }
          return thenable;
        },
        // lean(false) = documento completo (con save), como en Mongoose.
        lean(v)  { return Promise.resolve(doc ? (v === false ? doc : { ...doc }) : null); },
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
    // Devuelve una promesa con .lean() encadenable (como Mongoose).
    findOneAndUpdate(query = {}, update = {}, opts = {}) {
      const p = this._findOneAndUpdate(query, update, opts);
      p.lean = () => p;
      return p;
    },
    async _findOneAndUpdate(query = {}, update = {}, opts = {}) {
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
      applySet(doc, set);
      if (update.$inc) Object.entries(update.$inc).forEach(([k, n]) => { doc[k] = (Number(doc[k]) || 0) + n; });
      doc.updatedAt = new Date();
      return { ...doc };
    },

    // updateOne MÍNIMO: mismo tratamiento de $set / $inc / objeto plano que
    // findOneAndUpdate (lo usa, p. ej., el login de backoffice para lastLoginAt).
    async updateOne(query = {}, update = {}) {
      const doc = store.find(d => matches(d, query));
      if (!doc) return { matchedCount: 0, modifiedCount: 0 };
      const hasOps = Object.keys(update).some(k => k.startsWith('$'));
      applySet(doc, update.$set || (hasOps ? {} : update));
      if (update.$inc) Object.entries(update.$inc).forEach(([k, n]) => { doc[k] = (Number(doc[k]) || 0) + n; });
      doc.updatedAt = new Date();
      return { matchedCount: 1, modifiedCount: 1 };
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
