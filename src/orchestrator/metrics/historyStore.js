// src/orchestrator/metrics/historyStore.js

/**
 * Este módulo simula el almacenamiento de métricas históricas.
 * En futuras versiones, se conectará a MongoDB o Redis.
 * 
 * @param {Object} transaction - Objeto de la transacción
 * @returns {Object} - Métricas relevantes para la decisión
 */
async function getMetrics(transaction) {
  const { method, merchantId } = transaction;

  // En versión real: buscar métricas específicas en base al merchant, método, país, etc.

  // Mock: retornamos datos simulados
  return {
    visaAcquirer: {
      successRate: 0.92,
      avgLatency: 180 // en ms
    },
    mcAcquirer: {
      successRate: 0.89,
      avgLatency: 210
    },
    defaultCardAcquirer: {
      successRate: 0.87,
      avgLatency: 250
    },
    pixConnector: {
      successRate: 0.98,
      avgLatency: 100
    }
    // etc.
  };
}

module.exports = {
  getMetrics
};
