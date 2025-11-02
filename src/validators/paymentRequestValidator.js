// src/validators/paymentRequestValidator.js
'use strict';
const Joi = require('joi');

/* Validadores auxiliares */
const nameSchema = Joi.object({
  firstName: Joi.string().optional(),
  surname: Joi.string().optional(),
  title: Joi.string().optional()
});

const addressSchema = Joi.object({
  additionalInfo: Joi.string().optional(),
  city: Joi.string().optional(),
  countryCode: Joi.string().length(2).optional(),
  houseNumber: Joi.number().optional(),
  state: Joi.string().optional(),
  street: Joi.string().optional(),
  zip: Joi.alternatives().try(Joi.string(), Joi.number()).optional(),
  name: nameSchema.optional(),
  companyName: Joi.string().optional()
});

const contactDetailsSchema = Joi.object({
  emailAddress: Joi.string().email().optional(),
  faxNumber: Joi.string().optional(),
  mobilePhoneNumber: Joi.string().optional(),
  phoneNumber: Joi.string().optional(),
  workPhoneNumber: Joi.string().optional()
});

const browserDataSchema = Joi.object({
  colorDepth: Joi.number().optional(),
  javaEnabled: Joi.boolean().optional(),
  javaScriptEnabled: Joi.boolean().optional(),
  screenHeight: Joi.alternatives().try(Joi.string(), Joi.number()).optional(),
  screenWidth: Joi.alternatives().try(Joi.string(), Joi.number()).optional()
});

const deviceSchema = Joi.object({
  acceptHeader: Joi.string().optional(),
  browserData: browserDataSchema.optional(),
  ipAddress: Joi.string().optional(),
  locale: Joi.string().optional(),
  timezoneOffsetUtcMinutes: Joi.string().optional(),
  userAgent: Joi.string().optional(),
  deviceFingerprint: Joi.string().optional()
});

const personalInfoSchema = Joi.object({
  dateOfBirth: Joi.string().optional(),
  gender: Joi.string().optional(),
  name: nameSchema.optional()
});

const customerSchema = Joi.object({
  billingAddress: addressSchema.optional(),
  contactDetails: contactDetailsSchema.optional(),
  device: deviceSchema.optional(),
  fiscalNumber: Joi.string().optional(),
  locale: Joi.string().optional(),
  personalInformation: personalInfoSchema.optional()
});

const threeDSecureSchema = Joi.object({
  challengeCanvasSize: Joi.string().optional(),
  challengeIndicator: Joi.string().optional(),
  priorThreeDSecureData: Joi.object({
    acsTransactionId: Joi.string().optional(),
    method: Joi.string().optional(),
    utcTimestamp: Joi.string().optional()
  }).optional(),
  skipAuthentication: Joi.boolean().optional(),
  exemptionRequest: Joi.string().optional(),
  merchantFraudRate: Joi.number().optional(),
  secureCorporatePayment: Joi.boolean().optional(),
  skipSoftDecline: Joi.boolean().optional(),
  authenticationAmount: Joi.number().optional()
});

const cardPaymentMethodSpecificInputSchema = Joi.object({
  authorizationMode: Joi.string().optional(),
  initialSchemeTransactionId: Joi.string().optional(),
  recurring: Joi.object({
    recurringPaymentSequenceIndicator: Joi.string().optional()
  }).optional(),
  token: Joi.string().optional(),
  tokenize: Joi.boolean().optional(),
  transactionChannel: Joi.string().optional(),
  unscheduledCardOnFileRequestor: Joi.string().optional(),
  unscheduledCardOnFileSequenceIndicator: Joi.string().optional(),
  paymentProductId: Joi.number().optional(),
  threeDSecure: threeDSecureSchema.optional()
});

const hostedCheckoutSpecificInputSchema = Joi.object({
  isRecurring: Joi.boolean().optional(),
  locale: Joi.string().optional(),
  returnUrl: Joi.string().uri().optional(),
  showResultPage: Joi.boolean().optional(),
  tokens: Joi.string().optional(),
  variant: Joi.string().optional(),
  cardPaymentMethodSpecificInput: Joi.object({
    groupCards: Joi.boolean().optional(),
    clickToPay: Joi.boolean().optional(),
    paymentProductPreferredOrder: Joi.array().items(Joi.number()).optional()
  }).optional(),
  sessionTimeout: Joi.number().optional(),
  allowedNumberOfPaymentAttempts: Joi.number().optional(),
  // ➕ Permitimos activar captura automática (SALE)
  autoCapture: Joi.boolean().optional()
});

const orderSchema = Joi.object({
  amountOfMoney: Joi.object({
    amount: Joi.number().positive().required(),
    currencyCode: Joi.string().length(3).uppercase().required()
  }).required(),
  customer: customerSchema.optional(),
  references: Joi.object({
    descriptor: Joi.string().max(22).optional(),
    merchantReference: Joi.string().required(),
    merchantParameters: Joi.string().optional()
  }).required(),
  shipping: Joi.object({
    address: addressSchema.optional(),
    addressIndicator: Joi.string().optional(),
    emailAddress: Joi.string().email().optional(),
    firstUsageDate: Joi.string().optional(),
    isFirstUsage: Joi.boolean().optional(),
    method: Joi.object({
      details: Joi.string().optional(),
      name: Joi.string().optional(),
      speed: Joi.number().optional(),
      type: Joi.string().optional()
    }).optional(),
    type: Joi.string().optional(),
    shippingCost: Joi.number().optional(),
    shippingCostTax: Joi.number().optional()
  }).optional(),
  feedbacks: Joi.object({
    webhooksUrls: Joi.array().items(Joi.string().uri()).optional(),
    webhookUrl: Joi.string().uri().optional()
  }).optional()
});

const paymentRequestSchema = Joi.object({
  merchantId: Joi.string().required(),
  cardPaymentMethodSpecificInput: cardPaymentMethodSpecificInputSchema.optional(),
  hostedCheckoutSpecificInput: hostedCheckoutSpecificInputSchema.optional(),
  order: orderSchema.required()
}).prefs({ allowUnknown: false });

module.exports = paymentRequestSchema;
