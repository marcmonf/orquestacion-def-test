// src/dtos/paymentNodeDTOs.js
'use strict';

const Joi = require('joi');
const { getSupportedCurrencies } = require('../utils/currencyConfig');

// Importe máximo por pago en unidades menores (céntimos). Guarda técnica contra
// importes absurdos; ajustable con MAX_PAYMENT_AMOUNT. Por defecto 1.000.000,00.
const MAX_PAYMENT_AMOUNT = parseInt(process.env.MAX_PAYMENT_AMOUNT || '100000000', 10);

// URLs a las que se REDIRIGE al comprador: solo http(s). Joi.uri() a secas
// admite javascript:, data:, etc. (son URIs válidas según el RFC).
const RedirectUrl = () => Joi.string().uri({ scheme: ['https', 'http'] }).max(2048);

// URLs a las que Monetiser envía webhooks: solo https (el dispatcher solo habla
// TLS y además bloquea destinos de red privada — ver webhookDispatcher.js).
const WebhookUrl = () => Joi.string().uri({ scheme: ['https'] }).max(2048);

/**
 * Nodo: AmountOfMoney (genérico: líneas de carrito, recargos, tarjetas regalo...)
 * Siempre entero en unidades menores y no negativo.
 */
const AmountOfMoneyDTO = Joi.object({
  amount: Joi.number().integer().min(0).max(MAX_PAYMENT_AMOUNT).required(),
  currencyCode: Joi.string().length(3).uppercase().required()
});

/**
 * Importe TOTAL del pedido (lo que se cobra). Más estricto que el genérico:
 *   - entero ≥ 1 en unidades menores (antes Joi.number() aceptaba negativos,
 *     cero y decimales: un pago de -1000 o de 10.5 céntimos se creaba sin más);
 *   - divisa dentro de SUPPORTED_CURRENCIES (ver utils/currencyConfig.js).
 */
const OrderAmountOfMoneyDTO = Joi.object({
  amount: Joi.number().integer().min(1).max(MAX_PAYMENT_AMOUNT).required(),
  currencyCode: Joi.string().length(3).uppercase().valid(...getSupportedCurrencies()).required()
    .messages({ 'any.only': 'currency_not_supported: {{#label}} debe ser una de [{{#valids}}]' })
});

/**
 * Nodo: FraudFields
 */
const FraudFieldsDTO = Joi.object({
  blackListData: Joi.string().optional(),
  customerIpAddress: Joi.string().optional(),
  productCategories: Joi.array().items(Joi.string()).optional()
});

/**
 * Nodos relacionados con airlineData
 */
const AirlineLegDTO = Joi.object({
  airlineClass: Joi.string().optional(),
  arrivalAirport: Joi.string().optional(),
  arrivalTime: Joi.string().optional(),
  carrierCode: Joi.string().optional(),
  conjunctionTicket: Joi.string().optional(),
  couponNumber: Joi.string().optional(),
  date: Joi.string().optional(),
  departureTime: Joi.string().optional(),
  endorsementOrRestriction: Joi.string().optional(),
  exchangeTicket: Joi.string().optional(),
  fare: Joi.string().optional(),
  legFare: Joi.number().optional(),
  fareBasis: Joi.string().optional(),
  fee: Joi.number().optional(),
  flightNumber: Joi.string().optional(),
  number: Joi.number().optional(),
  originAirport: Joi.string().optional(),
  passengerClass: Joi.string().optional(),
  stopoverCode: Joi.string().optional(),
  taxes: Joi.number().optional()
});

const AirlinePassengerDTO = Joi.object({
  airlineLoyaltyStatus: Joi.string().optional(),
  firstName: Joi.string().optional(),
  surname: Joi.string().optional(),
  surnamePrefix: Joi.string().optional(),
  title: Joi.string().optional(),
  passengerType: Joi.string().optional()
});

const AirlineDataDTO = Joi.object({
  agentNumericCode: Joi.string().optional(),
  code: Joi.string().optional(),
  flightDate: Joi.string().optional(),
  flightIndicator: Joi.string().optional(),
  flightLegs: Joi.array().items(AirlineLegDTO).optional(),
  invoiceNumber: Joi.string().optional(),
  isETicket: Joi.boolean().optional(),
  isRestrictedTicket: Joi.boolean().optional(),
  isThirdParty: Joi.boolean().optional(),
  issueDate: Joi.string().optional(),
  merchantCustomerId: Joi.string().optional(),
  name: Joi.string().optional(),
  passengerName: Joi.string().optional(),
  passengers: Joi.array().items(AirlinePassengerDTO).optional(),
  placeOfIssue: Joi.string().optional(),
  pnr: Joi.string().optional(),
  pointOfSale: Joi.string().optional(),
  posCityCode: Joi.string().optional(),
  ticketCurrency: Joi.string().optional(),
  ticketDeliveryMethod: Joi.string().optional(),
  ticketNumber: Joi.string().optional(),
  totalFare: Joi.number().optional(),
  totalFee: Joi.number().optional(),
  totalTaxes: Joi.number().optional(),
  travelAgencyName: Joi.string().optional()
});

/**
 * Nodo: LoanRecipient
 */
const LoanRecipientDTO = Joi.object({
  accountNumber: Joi.string().optional(),
  dateOfBirth: Joi.string().optional(),
  partialPan: Joi.string().optional(),
  surname: Joi.string().optional(),
  zip: Joi.string().optional()
});

/**
 * Nodo: LodgingData
 */
const LodgingDataDTO = Joi.object({
  checkInDate: Joi.string().optional()
});

/**
 * Nodo: TypeInformation
 */
const TypeInformationDTO = Joi.object({
  purchaseType: Joi.string().optional(),
  transactionType: Joi.string().optional()
});

/**
 * Nodo: AdditionalInput
 */
const AdditionalInputDTO = Joi.object({
  airlineData: AirlineDataDTO.optional(),
  loanRecipient: LoanRecipientDTO.optional(),
  lodgingData: LodgingDataDTO.optional(),
  typeInformation: TypeInformationDTO.optional()
});

/**
 * Nodos de Customer
 */

const AccountAuthenticationDTO = Joi.object({
  data: Joi.string().optional(),
  method: Joi.string().optional(),
  utcTimestamp: Joi.string().optional()
});

const PaymentAccountOnFileDTO = Joi.object({
  createDate: Joi.string().optional(),
  numberOfCardOnFileCreationAttemptsLast24Hours: Joi.number().optional()
});

const PaymentActivityDTO = Joi.object({
  numberOfPaymentAttemptsLast24Hours: Joi.number().optional(),
  numberOfPaymentAttemptsLastYear: Joi.number().optional(),
  numberOfPurchasesLast6Months: Joi.number().optional()
});

const CustomerAccountDTO = Joi.object({
  authentication: AccountAuthenticationDTO.optional(),
  changeDate: Joi.string().optional(),
  changedDuringCheckout: Joi.boolean().optional(),
  createDate: Joi.string().optional(),
  hadSuspiciousActivity: Joi.boolean().optional(),
  passwordChangeDate: Joi.string().optional(),
  passwordChangedDuringCheckout: Joi.boolean().optional(),
  paymentAccountOnFile: PaymentAccountOnFileDTO.optional(),
  paymentActivity: PaymentActivityDTO.optional()
});

const CompanyInformationDTO = Joi.object({
  name: Joi.string().optional()
});

const BillingAddressDTO = Joi.object({
  additionalInfo: Joi.string().optional(),
  city: Joi.string().optional(),
  countryCode: Joi.string().optional(),
  houseNumber: Joi.alternatives(Joi.string(), Joi.number()).optional(),
  state: Joi.string().optional(),
  street: Joi.string().optional(),
  zip: Joi.alternatives(Joi.string(), Joi.number()).optional()
});

const ContactDetailsDTO = Joi.object({
  emailAddress: Joi.string().optional(),
  faxNumber: Joi.string().optional(),
  mobilePhoneNumber: Joi.string().optional(),
  phoneNumber: Joi.string().optional(),
  workPhoneNumber: Joi.string().optional()
});

const BrowserDataDTO = Joi.object({
  colorDepth: Joi.number().optional(),
  javaEnabled: Joi.boolean().optional(),
  javaScriptEnabled: Joi.boolean().optional(),
  screenHeight: Joi.string().optional(),
  screenWidth: Joi.string().optional()
});

const DeviceDTO = Joi.object({
  acceptHeader: Joi.string().optional(),
  browserData: BrowserDataDTO.optional(),
  ipAddress: Joi.string().optional(),
  locale: Joi.string().optional(),
  timezoneOffsetUtcMinutes: Joi.string().optional(),
  userAgent: Joi.string().optional(),
  deviceFingerprint: Joi.string().optional()
});

const PersonalNameDTO = Joi.object({
  firstName: Joi.string().optional(),
  surname: Joi.string().optional(),
  title: Joi.string().optional()
});

const PersonalInformationDTO = Joi.object({
  dateOfBirth: Joi.string().optional(),
  gender: Joi.string().optional(),
  name: PersonalNameDTO.optional()
});

const CustomerDTO = Joi.object({
  companyInformation: CompanyInformationDTO.optional(),
  merchantCustomerId: Joi.string().optional(),
  account: CustomerAccountDTO.optional(),
  accountType: Joi.string().optional(),
  billingAddress: BillingAddressDTO.optional(),
  contactDetails: ContactDetailsDTO.optional(),
  device: DeviceDTO.optional(), // aparece en el S2S
  fiscalNumber: Joi.string().optional(),
  locale: Joi.string().optional(),
  personalInformation: PersonalInformationDTO.optional()
});

/**
 * Nodo: References
 */
const ReferencesDTO = Joi.object({
  descriptor: Joi.string().optional(),
  merchantReference: Joi.string().optional(),
  merchantParameters: Joi.string().optional(),
  operationGroupReference: Joi.string().optional()
});

/**
 * Nodos de Shipping
 */
const ShippingNameDTO = Joi.object({
  firstName: Joi.string().optional(),
  surname: Joi.string().optional(),
  title: Joi.string().optional()
});

const ShippingAddressDTO = Joi.object({
  additionalInfo: Joi.string().optional(),
  city: Joi.string().optional(),
  countryCode: Joi.string().optional(),
  houseNumber: Joi.alternatives(Joi.string(), Joi.number()).optional(),
  state: Joi.string().optional(),
  street: Joi.string().optional(),
  zip: Joi.alternatives(Joi.string(), Joi.number()).optional(),
  name: ShippingNameDTO.optional(),
  companyName: Joi.string().optional()
});

const ShippingMethodDTO = Joi.object({
  details: Joi.string().optional(),
  name: Joi.string().optional(),
  speed: Joi.number().optional(),
  type: Joi.string().optional()
});

const ShippingDTO = Joi.object({
  address: ShippingAddressDTO.optional(),
  addressIndicator: Joi.string().optional(),
  emailAddress: Joi.string().optional(),
  firstUsageDate: Joi.string().optional(),
  isFirstUsage: Joi.boolean().optional(),
  method: ShippingMethodDTO.optional(),
  type: Joi.string().optional(),
  shippingCost: Joi.number().optional(),
  shippingCostTax: Joi.number().optional()
});

/**
 * Nodos de ShoppingCart
 */
const ShoppingCartAmountBreakdownItemDTO = Joi.object({
  amount: Joi.number().optional(),
  type: Joi.string().optional()
});

const GiftCardPurchaseDTO = Joi.object({
  amountOfMoney: AmountOfMoneyDTO.optional(),
  numberOfGiftCards: Joi.number().optional()
});

const ShoppingCartItemInvoiceDataDTO = Joi.object({
  description: Joi.string().optional()
});

const ShoppingCartItemOrderLineDetailsDTO = Joi.object({
  discountAmount: Joi.number().optional(),
  productCode: Joi.string().optional(),
  productBrand: Joi.string().optional(),
  productName: Joi.string().optional(),
  productPrice: Joi.number().optional(),
  productType: Joi.string().optional(),
  quantity: Joi.number().optional(),
  taxAmount: Joi.number().optional(),
  unit: Joi.string().optional()
});

const ShoppingCartItemOtherDetailsDTO = Joi.object({
  travelData: Joi.string().optional(),
  metaData: Joi.string().optional()
});

const ShoppingCartItemDTO = Joi.object({
  amountOfMoney: AmountOfMoneyDTO.optional(),
  invoiceData: ShoppingCartItemInvoiceDataDTO.optional(),
  orderLineDetails: ShoppingCartItemOrderLineDetailsDTO.optional(),
  otherDetails: ShoppingCartItemOtherDetailsDTO.optional()
});

const ShoppingCartDTO = Joi.object({
  amountBreakdown: Joi.array().items(ShoppingCartAmountBreakdownItemDTO).optional(),
  giftCardPurchase: GiftCardPurchaseDTO.optional(),
  isPreOrder: Joi.boolean().optional(),
  items: Joi.array().items(ShoppingCartItemDTO).optional(),
  preOrderItemAvailabilityDate: Joi.string().optional(),
  reOrderIndicator: Joi.boolean().optional()
});

/**
 * Nodo: SurchargeSpecificInput
 */
const SurchargeSpecificInputDTO = Joi.object({
  mode: Joi.string().optional(),
  surchargeAmount: AmountOfMoneyDTO.optional()
});

/**
 * Nodo: Discount
 */
const DiscountDTO = Joi.object({
  amount: Joi.number().optional()
});

/**
 * Nodo raíz ORDER (común Hosted + S2S)
 */
const OrderDTO = Joi.object({
  additionalInput: AdditionalInputDTO.optional(),
  amountOfMoney: OrderAmountOfMoneyDTO.required(),
  customer: CustomerDTO.optional(),
  references: ReferencesDTO.optional(),
  shipping: ShippingDTO.optional(),
  shoppingCart: ShoppingCartDTO.optional(),
  surchargeSpecificInput: SurchargeSpecificInputDTO.optional(),
  discount: DiscountDTO.optional(),
  totalTaxAmount: Joi.number().optional()
});

/**
 * Nodos de cardPaymentMethodSpecificInput
 */

const PriorThreeDSecureDataDTO = Joi.object({
  acsTransactionId: Joi.string().optional(),
  method: Joi.string().optional(),
  utcTimestamp: Joi.string().optional()
});

const RedirectionDataDTO = Joi.object({
  returnUrl: RedirectUrl().required()
});

const ExternalCardholderAuthenticationDataDTO = Joi.object({
  cavv: Joi.string().optional(),
  cavvAlgorithm: Joi.string().optional(),
  eci: Joi.number().optional(),
  threeDSecureVersion: Joi.string().optional(),
  xid: Joi.string().optional(),
  directoryServerTransactionId: Joi.string().optional(),
  schemeRiskScore: Joi.number().optional(),
  acsTransactionId: Joi.string().optional(),
  appliedExemption: Joi.string().optional(),
  flow: Joi.string().optional()
});

const ThreeDSecureDTO = Joi.object({
  challengeCanvasSize: Joi.string().optional(),
  challengeIndicator: Joi.string().optional(),
  priorThreeDSecureData: PriorThreeDSecureDataDTO.optional(),
  skipAuthentication: Joi.boolean().optional(),
  redirectionData: RedirectionDataDTO.required(),
  externalCardholderAuthenticationData: ExternalCardholderAuthenticationDataDTO.optional(),
  exemptionRequest: Joi.string().optional(),
  merchantFraudRate: Joi.number().optional(),
  secureCorporatePayment: Joi.boolean().optional(),
  skipSoftDecline: Joi.boolean().optional(),
  authenticationAmount: Joi.number().optional(),
  deviceChannel: Joi.string().optional()
});

const NetworkTokenDataDTO = Joi.object({
  cardholderName: Joi.string().optional(),
  networkToken: Joi.string().optional(),
  tokenExpiryDate: Joi.number().optional(),
  cryptogram: Joi.string().optional(),
  eci: Joi.number().optional(),
  schemeTokenRequestorId: Joi.string().optional()
});

const CurrencyConversionDTO = Joi.object({
  acceptedByUser: Joi.boolean().optional(),
  dccSessionId: Joi.string().optional()
});

const MultiplePaymentInformationDTO = Joi.object({
  paymentPattern: Joi.string().optional(),
  totalNumberOfPayments: Joi.number().optional()
});

const CardDTO = Joi.object({
  cardholderName: Joi.string().optional(),
  cardNumber: Joi.string().optional(),
  expiryDate: Joi.number().optional(),
  cvv: Joi.string().optional()
});

const CardPaymentMethodSpecificInputDTO = Joi.object({
  authorizationMode: Joi.string().optional(),
  initialSchemeTransactionId: Joi.string().optional(),
  schemeReferenceData: Joi.string().optional(),
  recurring: Joi.object({
    recurringPaymentSequenceIndicator: Joi.string().optional()
  }).optional(),
  skipAuthentication: Joi.boolean().optional(),
  token: Joi.string().optional(),
  tokenize: Joi.boolean().optional(),
  transactionChannel: Joi.string().optional(),
  unscheduledCardOnFileRequestor: Joi.string().optional(),
  unscheduledCardOnFileSequenceIndicator: Joi.string().optional(),
  paymentProductId: Joi.number().optional(),
  card: CardDTO.optional(),
  networkTokenData: NetworkTokenDataDTO.optional(),
  isRecurring: Joi.boolean().optional(),
  returnUrl: RedirectUrl().optional(), // aunque el oficial lo tomamos de threeDSecure.redirectionData.returnUrl
  threeDSecure: ThreeDSecureDTO.required(),
  currencyConversion: CurrencyConversionDTO.optional(),
  cardOnFileRecurringFrequency: Joi.string().optional(),
  cardOnFileRecurringExpiration: Joi.string().optional(),
  allowDynamicLinking: Joi.boolean().optional(),
  multiplePaymentInformation: MultiplePaymentInformationDTO.optional(),
  cobrandSelectionIndicator: Joi.string().optional()
});

/**
 * Nodo: Feedbacks
 */
const FeedbacksDTO = Joi.object({
  webhooksUrls: Joi.array().items(WebhookUrl()).max(5).optional(),
  webhookUrl: WebhookUrl().optional()
});

module.exports = {
  MAX_PAYMENT_AMOUNT,
  RedirectUrl,
  WebhookUrl,
  AmountOfMoneyDTO,
  OrderAmountOfMoneyDTO,
  FraudFieldsDTO,
  AirlineDataDTO,
  LoanRecipientDTO,
  LodgingDataDTO,
  TypeInformationDTO,
  AdditionalInputDTO,
  CustomerDTO,
  ReferencesDTO,
  ShippingDTO,
  ShoppingCartDTO,
  SurchargeSpecificInputDTO,
  DiscountDTO,
  OrderDTO,
  PriorThreeDSecureDataDTO,
  RedirectionDataDTO,
  ExternalCardholderAuthenticationDataDTO,
  ThreeDSecureDTO,
  NetworkTokenDataDTO,
  CurrencyConversionDTO,
  MultiplePaymentInformationDTO,
  CardDTO,
  CardPaymentMethodSpecificInputDTO,
  FeedbacksDTO
};
