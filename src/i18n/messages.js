// src/i18n/messages.js

module.exports = {
  en: {
    internalError: 'Internal server error.',
    invalidApiKey: 'Invalid or missing API key.',
    rateLimitExceeded: 'Too many requests from this IP. Please try again later.',

    // Tokens
    tokenNotFound: 'Token not found.',
    cardTokenized: 'Card successfully tokenized.',
    invalidCardNumber: 'Invalid card number.',
    invalidCvv: 'CVV must be 3 or 4 digits.',
    invalidExpiryMonth: 'expiryMonth must be a value between 01 and 12.',
    invalidExpiryYear: 'expiryYear must be a 4-digit value.',
    expiryYearTooLow: 'expiryYear cannot be in the past.',
    holderNameRequired: 'cardholderName is required.',
    holderNameTooShort: 'cardholderName must have at least 2 characters.',
    holderNameTooLong: 'cardholderName must not exceed 64 characters.',

    // Transactions
    transactionCreated: 'Transaction successfully created.',
    transactionNotFound: 'Transaction not found.',
    transactionUpdated: 'Transaction successfully updated.',
    transactionDeleted: 'Transaction successfully deleted.',
    validationError: 'Validation error.'
  },

  es: {
    internalError: 'Error interno del servidor.',
    invalidApiKey: 'Clave API inválida o ausente.',
    rateLimitExceeded: 'Demasiadas peticiones desde esta IP. Intenta nuevamente más tarde.',

    // Tokens
    tokenNotFound: 'Token no encontrado.',
    cardTokenized: 'Tarjeta tokenizada correctamente.',
    invalidCardNumber: 'Número de tarjeta inválido.',
    invalidCvv: 'El CVV debe tener 3 o 4 dígitos.',
    invalidExpiryMonth: 'expiryMonth debe ser un valor entre 01 y 12.',
    invalidExpiryYear: 'expiryYear debe tener 4 dígitos.',
    expiryYearTooLow: 'expiryYear no puede ser menor que el año actual.',
    holderNameRequired: 'cardholderName es obligatorio.',
    holderNameTooShort: 'cardholderName debe tener al menos 2 caracteres.',
    holderNameTooLong: 'cardholderName no puede superar los 64 caracteres.',

    // Transacciones
    transactionCreated: 'Transacción creada correctamente.',
    transactionNotFound: 'Transacción no encontrada.',
    transactionUpdated: 'Transacción actualizada correctamente.',
    transactionDeleted: 'Transacción eliminada correctamente.',
    validationError: 'Error de validación.'
  },

  fr: {
    internalError: 'Erreur interne du serveur.',
    invalidApiKey: 'Clé API invalide ou manquante.',
    rateLimitExceeded: 'Trop de requêtes depuis cette IP. Veuillez réessayer plus tard.',

    // Tokens
    tokenNotFound: 'Jeton introuvable.',
    cardTokenized: 'Carte tokenisée avec succès.',
    invalidCardNumber: 'Numéro de carte invalide.',
    invalidCvv: 'Le CVV doit comporter 3 ou 4 chiffres.',
    invalidExpiryMonth: 'expiryMonth doit être une valeur entre 01 et 12.',
    invalidExpiryYear: 'expiryYear doit contenir 4 chiffres.',
    expiryYearTooLow: "expiryYear ne peut pas être inférieur à l'année actuelle.",
    holderNameRequired: 'cardholderName est requis.',
    holderNameTooShort: 'cardholderName doit comporter au moins 2 caractères.',
    holderNameTooLong: 'cardholderName ne doit pas dépasser 64 caractères.',

    // Transacciones
    transactionCreated: 'Transaction créée avec succès.',
    transactionNotFound: 'Transaction introuvable.',
    transactionUpdated: 'Transaction mise à jour avec succès.',
    transactionDeleted: 'Transaction supprimée avec succès.',
    validationError: 'Erreur de validation.'
  }
};
