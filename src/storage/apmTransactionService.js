const ApmTransaction = require('../models/ApmTransaction');

exports.saveApmTransaction = async (tx) => {
  const apmTx = new ApmTransaction(tx);
  return await apmTx.save();
};
