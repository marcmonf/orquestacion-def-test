const Stripe = require('stripe');
const PaymentConnector = require('./PaymentConnector');

const SOFT_DECLINE_CODES = new Set([
  'insufficient_funds',
  'processing_error',
  'try_again_later',
  'issuer_not_available',
]);

class StripeConnector extends PaymentConnector {
  constructor(apiKey) {
    super('stripe');
    this.stripe = new Stripe(apiKey, { apiVersion: '2023-10-16' });
  }

  /** @param {object} paymentData — campos normalizados por Monetiser */
  async authorize(paymentData) {
    try {
      const intent = await this.stripe.paymentIntents.create({
        amount: paymentData.amount,
        currency: paymentData.currency,
        payment_method_data: {
          type: 'card',
          card: {
            number: paymentData.card.number,
            exp_month: paymentData.card.expMonth,
            exp_year: paymentData.card.expYear,
            cvc: paymentData.card.cvc,
          },
        },
        metadata: {
          paymentId: paymentData.paymentId,
        },
        confirm: true,
      });

      return {
        success: intent.status === 'succeeded',
        responseCode: intent.last_payment_error?.code || 'approved',
        processorReference: intent.id,
      };
    } catch (err) {
      return {
        success: false,
        responseCode: err.code || 'stripe_error',
        processorReference: err.raw?.payment_intent?.id || null,
      };
    }
  }

  isSoftDecline(responseCode) {
    return SOFT_DECLINE_CODES.has(responseCode);
  }
}

module.exports = StripeConnector;
