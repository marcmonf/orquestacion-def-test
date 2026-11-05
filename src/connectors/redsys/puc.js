// src/connectors/redsys/puc.js
'use strict';
//
// ARMAZÓN APAGADO: modo de terminal "redsys_puc" (sesión 6 nov 2026, F5).
//
// PUC = Protocolo Unificado para Comercio de Redsys: el protocolo con el que un
// TPV FÍSICO habla con Redsys. NO TENEMOS LA ESPECIFICACIÓN (es de Redsys y no
// es pública; tampoco se pudo abrir redsys.es desde el contenedor). Por eso aquí
// NO hay ni un solo mensaje, campo ni código del protocolo: solo la interfaz que
// el resto de card present (FEATURE_CARD_PRESENT, también apagado) usaría, y
// todas sus operaciones responden not_supported.
//
// Para implementarlo hace falta: la especificación PUC de Redsys, un terminal
// homologado y el alta del comercio en Redsys para pago presencial
// (DECISIÓN PENDIENTE DE MARCOS en el DEV-LOG).

const { makeError } = require('../errors');

const MODE = 'redsys_puc';
const MISSING = 'Redsys PUC: falta la especificación del protocolo (Redsys). Armazón apagado.';

function enabled() {
  // Nunca activo hasta tener la especificación: el flag de card present no basta.
  return false;
}

const notYet = async () => ({ success: false, error: makeError('not_supported', MISSING) });

module.exports = Object.freeze({
  MODE,
  enabled,
  // Interfaz prevista (vacía). Ninguna recibe ni devuelve datos de tarjeta en claro.
  /** Emparejar el terminal con la cuenta Redsys del comercio. */
  pair: notYet,
  /** Iniciar una venta presencial por `amount` céntimos en el terminal `terminalId`. */
  startSale: notYet,
  /** Anular la venta en curso del terminal. */
  cancelSale: notYet,
  /** Estado de la última operación del terminal. */
  status: notYet,
});
