exports.validate = function (tx) {
  if (!tx.amount || tx.amount <= 0) return { success: false, reason: "Invalid amount" };
  if (!tx.merchantId) return { success: false, reason: "Missing merchant ID" };
  return { success: true };
};
