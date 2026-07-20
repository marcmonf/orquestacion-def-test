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
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if ('$ne' in v) return doc[k] !== v.$ne;
      if ('$in' in v) return v.$in.includes(doc[k]);
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
    const q = {
      select() { return q; },
      sort()   { return q; },
      lean()   { return Promise.resolve(rows.map(r => ({ ...r }))); },
      then(resolve, reject) {
        return Promise.resolve(rows.map(r => ({ ...r }))).then(resolve, reject);
      },
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

    // findOne se AWAITEA directamente y su resultado puede llamar .save() → doc real.
    async findOne(query = {}) {
      return store.find(d => matches(d, query)) || null;
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
  };
};
