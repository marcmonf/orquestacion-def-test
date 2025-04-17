const bizum = require('../connectors/bizumConnector');
const blik = require('../connectors/blikConnector');
// Puedes añadir más APMs aquí:
// const twint = require('../connectors/twintConnector');
// const mbway = require('../connectors/mbwayConnector');

const apmHub = async (tx) => {
  switch (tx.method) {
    case 'bizum':
      return await bizum.process(tx);

    case 'blik':
      return await blik.process(tx);

    // Añadir más casos según APMs disponibles:
    // case 'twint':
    //   return await twint.process(tx);

    default:
      throw new Error(`APM no soportado: ${tx.method}`);
  }
};

module.exports = apmHub;
