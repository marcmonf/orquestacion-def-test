const bizum = require('./connectors/bizumConnector');
const blik = require('./connectors/blikConnector');
const mbway = require('./connectors/mbwayConnector');
// Puedes añadir más APMs aquí:
// const twint = require('./connectors/twintConnector');

const apmHub = async (tx) => {
  switch (tx.method) {
    case 'bizum':
      return await bizum.process(tx);
    case 'blik':
      return await blik.process(tx);
    case 'mbway':
      return await mbway.process(tx);
    // case 'twint':
    //   return await twint.process(tx);
    default:
      throw new Error(`APM no soportado: ${tx.method}`);
  }
};

module.exports = apmHub;
