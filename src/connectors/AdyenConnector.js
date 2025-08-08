const axios = require('axios').default;
const PaymentConnector = require('./PaymentConnector');

const ADYEN_ENDPOINT = 'https://checkout-test.adyen.com/v70/payments';

const SOFT_DECLINE_REASONS = new Set([
  'Refused',              // genérico, volver a intentar
  'IssuerUnavailable',
  'NotEnoughBalance',
  'ProcessingError',
]);

class AdyenConnector extends PaymentConnector {
  constructor(apiKey, merchantAccount) {
    super('adyen');
    this.apiKey = apiKey;
    this.merchantAccount = merchantAccount;
  }

  async authorize(paymentData) {
    try {
      const { data } = await axios.post(
        ADYEN_ENDPOINT,
        {
          amount: {
            currency: paymentData.currency,
            value: paymentData.amount,
          },
          reference: paymentData.paymentId,
          paymentMethod: {
            type: 'scheme',
            number: paymentData.card.number,
            expiryMonth: paymentData.card.expMonth,
            expiryYear: paymentData.card.expYear,
            cvc: paymentData.card.cvc,
          },
          merchantAccount: this.merchantAccount,
        },
        {
          headers: { 'X-API-Key': this.apiKey },
          timeout: 6000,
        }
      );

      return {
        success: data.resultCode === 'Authorised',
        responseCode: data.refusalReason || 'approved',
        processorReference: data.pspReference,
      };
    } catch (err) {
      return {
        success: false,
        responseCode: err.response?.data?.refusalReason || 'adyen_error',
        processorReference: err.response?.data?.pspReference || null,
      };
    }
  }

  isSoftDecline(responseCode) {
    return SOFT_DECLINE_REASONS.has(responseCode);
  }
}

module.exports = AdyenConnector;
