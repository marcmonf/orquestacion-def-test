const bizum = require('./connectors/bizumConnector');
// Aquí en el futuro irás añadiendo más conectores:
// const blik = require('./connectors/blikConnector');

const apmHub = async (tx) => {
  switch (tx.method) {
    case 'bizum':
      return await bizum.process(tx);
    // case 'blik':
    //   return await blik.process(tx);
    default:
      throw new Error(`APM no soportado: ${tx.method}`);
  }
};

module.exports = apmHub;
