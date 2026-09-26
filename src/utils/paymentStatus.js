// src/utils/paymentStatus.js
'use strict';
//
// FUENTE ÚNICA de los estados de una transacción y de sus agrupaciones.
//
// Por qué existe: los estados vivían escritos a mano en seis sitios distintos
// y cada lista se desviaba de las demás. Consecuencias reales que arregla:
//   - el endpoint de estado del Hosted Checkout devolvía `completed:false` para
//     siempre en pagos capturados o reembolsados (su lista de "finales" no los
//     incluía — mismo patrón que el bug canceled/cancelled del 16 jul 2026);
//   - las analíticas contaban solo `approved`, y los pagos reales de Paylands
//     acaban en `authorized`/`captured` → tasa de aprobación ≈ 0 con datos reales;
//   - un webhook tardío del adquirente podía hacer RETROCEDER una transacción
//     (p. ej. `captured` → `authorized`), porque se escribía el estado sin mirar
//     el de partida.
//
// `approved` y `refused` son sinónimos legados (`authorized` y `declined`). Se
// siguen reconociendo porque hay transacciones antiguas guardadas así.

// Estados en los que el pago todavía no tiene resultado.
const PENDING_STATUSES = Object.freeze([
  'initialized',
  'hosted_pending',
  'pending',
  'processing',     // cobro en curso contra el adquirente (reserva anti doble cobro)
  'pending_3ds',
]);

// El pago fue aprobado por el adquirente en algún momento (aunque después se
// capturase, reembolsase, etc.). Es la base de "aprobadas" en analíticas.
const SUCCESSFUL_STATUSES = Object.freeze([
  'approved',
  'authorized',
  'partially_captured',
  'captured',
  'partially_refunded',
  'refunded',
]);

// El pago no llegó a aprobarse.
const FAILED_STATUSES = Object.freeze([
  'declined',
  'refused',
  'failed',
  'error',
  'expired',
]);

function isPending(status) {
  return PENDING_STATUSES.includes(status);
}

// "Completado" = ya hay un resultado y el cliente no tiene nada más que hacer
// en el checkout. Cualquier estado que no sea pendiente.
function isCompleted(status) {
  return Boolean(status) && !isPending(status);
}

// ── Transiciones permitidas por una notificación del ADQUIRENTE ──────────────
// Un webhook solo puede hacer AVANZAR una transacción, nunca retroceder.
// Clave: estado destino. Valor: estados de partida desde los que se admite.
//
// 'error' figura como origen de authorized/declined/cancelled a propósito: el
// cobro marca 'error' si la llamada al adquirente falla por red, pero la orden
// pudo crearse igualmente — si el adquirente luego notifica el resultado, la
// realidad del adquirente manda.
const ACQUIRER_TRANSITIONS = Object.freeze({
  pending:            [...PENDING_STATUSES],
  authorized:         [...PENDING_STATUSES, 'approved', 'declined', 'error'],
  declined:           [...PENDING_STATUSES, 'error'],
  cancelled:          [...PENDING_STATUSES, 'approved', 'authorized', 'error'],
  partially_refunded: ['approved', 'authorized', 'partially_captured', 'captured', 'partially_refunded'],
  refunded:           ['approved', 'authorized', 'partially_captured', 'captured', 'partially_refunded'],
});

function acquirerCanTransition(from, to) {
  const allowed = ACQUIRER_TRANSITIONS[to];
  return Array.isArray(allowed) && allowed.includes(from);
}

module.exports = {
  PENDING_STATUSES,
  SUCCESSFUL_STATUSES,
  FAILED_STATUSES,
  ACQUIRER_TRANSITIONS,
  isPending,
  isCompleted,
  acquirerCanTransition,
};
