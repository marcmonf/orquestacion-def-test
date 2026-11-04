// src/utils/dbReady.js
'use strict';
//
// ¿Se puede consultar este modelo ya? Un modelo Mongoose REAL con la conexión
// caída se quedaría esperando (buffer) hasta su timeout; en ese caso se
// devuelve false y quien llama usa su valor por defecto (p. ej. la política de
// routing por defecto). Los modelos simulados de los tests no tienen
// `collection` y siempre se pueden consultar.

const mongoose = require('mongoose');

function canQuery(Model) {
  if (!Model || !Model.collection) return true;
  return mongoose.connection.readyState === 1;
}

module.exports = { canQuery };
