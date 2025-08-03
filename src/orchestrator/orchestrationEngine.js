// src/orchestrator/orchestrationEngine.js

const defaultStrategy = require('./strategies/defaultStrategy');
const metrics = require('./metrics/historyStore');

/**
 * Punto de entrada del motor de orquestación.
 * Selecciona el mejor conector en base a la estrategia definida.
 * 
 * @param {Object} transaction - Objeto de la transacción a procesar
 * @returns {String} - Nombre del conector seleccionado
 */
async function selectConnector(transaction) {
  try {
    // Obtener métricas históricas relacionadas con la transacción
    const currentMetrics = await metrics.getMetrics(transaction);

    // Aplicar estrategia para seleccionar el mejor conector
    const connector = await defaultStrategy(transaction, currentMetrics);

    return connector;
  } catch (error) {
    console.error('Error en el motor de orquestación:', error);
    throw new Error('Orchestration engine failed.');
  }
}

module.exports = {
  selectConnector
};
