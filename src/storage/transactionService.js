const Transaction = require('../models/Transaction');

exports.saveTransaction = async function (tx) {
  const transaction = new Transaction(tx);
  return await transaction.save();
};

exports.getAllTransactions = async function () {
  return await Transaction.find();
};

exports.getTransactionById = async function (id) {
  return await Transaction.findOne({ paymentId: id });
};

exports.updateTransactionStatus = async function (id, newStatus) {
  return await Transaction.updateOne(
    { paymentId: id },
    { status: newStatus, updatedAt: new Date() }
  );
};
