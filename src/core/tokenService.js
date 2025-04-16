exports.generateToken = function (cardNumber) {
  return "tok_" + Math.random().toString(36).substring(2, 15);
};

exports.getCardLast4 = function (cardNumber) {
  return cardNumber.slice(-4);
};
