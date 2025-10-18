// src/models/PaymentRequest.js
'use strict';
const mongoose = require('mongoose');

/* Subesquemas reutilizables */
const nameSchema = new mongoose.Schema({
  firstName: String,
  surname: String,
  title: String
}, { _id: false });

const addressSchema = new mongoose.Schema({
  additionalInfo: String,
  city: String,
  countryCode: String,
  houseNumber: Number,
  state: String,
  street: String,
  zip: String,
  name: nameSchema,
  companyName: String
}, { _id: false });

const contactDetailsSchema = new mongoose.Schema({
  emailAddress: String,
  faxNumber: String,
  mobilePhoneNumber: String,
  phoneNumber: String,
  workPhoneNumber: String
}, { _id: false });

const browserDataSchema = new mongoose.Schema({
  colorDepth: Number,
  javaEnabled: Boolean,
  javaScriptEnabled: Boolean,
  screenHeight: String,
  screenWidth: String
}, { _id: false });

const deviceSchema = new mongoose.Schema({
  acceptHeader: String,
  browserData: browserDataSchema,
  ipAddress: String,
  locale: String,
  timezoneOffsetUtcMinutes: String,
  userAgent: String,
  deviceFingerprint: String
}, { _id: false });

const personalInfoSchema = new mongoose.Schema({
  dateOfBirth: String,
  gender: String,
  name: nameSchema
}, { _id: false });

const customerSchema = new mongoose.Schema({
  billingAddress: addressSchema,
  contactDetails: contactDetailsSchema,
  device: deviceSchema,
  fiscalNumber: String,
  locale: String,
  personalInformation: personalInfoSchema
}, { _id: false });

const threeDSecureSchema = new mongoose.Schema({
  challengeCanvasSize: String,
  challengeIndicator: String,
  priorThreeDSecureData: {
    acsTransactionId: String,
    method: String,
    utcTimestamp: String
  },
  skipAuthentication: Boolean,
  exemptionRequest: String,
  merchantFraudRate: Number,
  secureCorporatePayment: Boolean,
  skipSoftDecline: Boolean,
  authenticationAmount: Number
}, { _id: false });

const cardPaymentMethodSpecificInputSchema = new mongoose.Schema({
  authorizationMode: String,
  initialSchemeTransactionId: String,
  recurring: {
    recurringPaymentSequenceIndicator: String
  },
  token: String,
  tokenize: Boolean,
  transactionChannel: String,
  unscheduledCardOnFileRequestor: String,
  unscheduledCardOnFileSequenceIndicator: String,
  paymentProductId: Number,
  threeDSecure: threeDSecureSchema
}, { _id: false });

const hostedCheckoutSpecificInputSchema = new mongoose.Schema({
  isRecurring: Boolean,
  locale: String,
  returnUrl: String,
  showResultPage: Boolean,
  tokens: String,
  variant: String,
  cardPaymentMethodSpecificInput: {
    groupCards: Boolean,
    clickToPay: Boolean,
    paymentProductPreferredOrder: [Number]
  },
  sessionTimeout: Number,
  allowedNumberOfPaymentAttempts: Number
}, { _id: false });

const orderSchema = new mongoose.Schema({
  amountOfMoney: {
    amount: Number,
    currencyCode: String
  },
  customer: customerSchema,
  references: {
    descriptor: String,
    merchantReference: String,
    merchantParameters: String
  },
  shipping: {
    address: addressSchema,
    addressIndicator: String,
    emailAddress: String,
    firstUsageDate: String,
    isFirstUsage: Boolean,
    method: {
      details: String,
      name: String,
      speed: Number,
      type: String
    },
    type: String,
    shippingCost: Number,
    shippingCostTax: Number
  },
  feedbacks: {
    webhooksUrls: [String],
    webhookUrl: String
  }
}, { _id: false });

const paymentRequestSchema = new mongoose.Schema({
  merchantId: { type: String, required: true },
  cardPaymentMethodSpecificInput: cardPaymentMethodSpecificInputSchema,
  hostedCheckoutSpecificInput: hostedCheckoutSpecificInputSchema,
  order: orderSchema,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.models.PaymentRequest ||
  mongoose.model('PaymentRequest', paymentRequestSchema);
