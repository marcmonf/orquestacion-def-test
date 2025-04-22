module.exports = {
  en: {
    // General
    'error.internal': 'Internal server error.',
    'error.unexpected': 'An unexpected error occurred on the server.',
    'error.invalidApiKey': 'Invalid or missing API key.',
    'error.rateLimit': 'Too many requests from this IP. Please try again later.',

    // Rate Limiting
    'rateLimit.tokens': 'Too many token requests. Please try again later.',
    'rateLimit.webhooks': 'Too many incoming webhook requests. Please try again later.',

    // Tokens
    'token.created': 'Card successfully tokenized.',
    'token.not.found': 'Token not found.',
    'token.error': 'An error occurred while tokenizing the card.',

    // Token validation
    'token.invalid.cardNumber': 'Invalid card number.',
    'token.invalid.cvv': 'CVV must be 3 or 4 digits.',
    'token.invalid.expiryMonth': 'expiryMonth must be a value between 01 and 12.',
    'token.invalid.expiryYear': 'expiryYear must be a 4-digit value.',
    'token.invalid.expiryYear.tooLow': 'expiryYear cannot be in the past.',
    'token.invalid.cardholderName.required': 'cardholderName is required.',
    'token.invalid.cardholderName.tooShort': 'cardholderName must have at least 2 characters.',
    'token.invalid.cardholderName.tooLong': 'cardholderName must not exceed 64 characters.',

    // Transactions
    'transaction.created': 'Transaction successfully created.',
    'transaction.not.found': 'Transaction not found.',
    'transaction.updated': 'Transaction successfully updated.',
    'transaction.deleted': 'Transaction successfully deleted.',
    'transaction.validation': 'Validation error.'
  },

  es: {
    // General
    'error.internal': 'Error interno del servidor.',
    'error.unexpected': 'Ocurrió un error inesperado en el servidor.',
    'error.invalidApiKey': 'Clave API inválida o ausente.',
    'error.rateLimit': 'Demasiadas peticiones desde esta IP. Intenta nuevamente más tarde.',

    // Rate Limiting
    'rateLimit.tokens': 'Demasiadas solicitudes de token. Intenta nuevamente más tarde.',
    'rateLimit.webhooks': 'Demasiadas peticiones entrantes al endpoint de webhooks. Intenta más tarde.',

    // Tokens
    'token.created': 'Tarjeta tokenizada correctamente.',
    'token.not.found': 'Token no encontrado.',
    'token.error': 'Ocurrió un error al tokenizar la tarjeta.',

    // Token validation
    'token.invalid.cardNumber': 'Número de tarjeta inválido.',
    'token.invalid.cvv': 'El CVV debe tener 3 o 4 dígitos.',
    'token.invalid.expiryMonth': 'expiryMonth debe ser un valor entre 01 y 12.',
    'token.invalid.expiryYear': 'expiryYear debe tener 4 dígitos.',
    'token.invalid.expiryYear.tooLow': 'expiryYear no puede ser menor que el año actual.',
    'token.invalid.cardholderName.required': 'cardholderName es obligatorio.',
    'token.invalid.cardholderName.tooShort': 'cardholderName debe tener al menos 2 caracteres.',
    'token.invalid.cardholderName.tooLong': 'cardholderName no puede superar los 64 caracteres.',

    // Transacciones
    'transaction.created': 'Transacción creada correctamente.',
    'transaction.not.found': 'Transacción no encontrada.',
    'transaction.updated': 'Transacción actualizada correctamente.',
    'transaction.deleted': 'Transacción eliminada correctamente.',
    'transaction.validation': 'Error de validación.'
  },

  fr: {
    // General
    'error.internal': 'Erreur interne du serveur.',
    'error.unexpected': 'Une erreur inattendue est survenue sur le serveur.',
    'error.invalidApiKey': 'Clé API invalide ou manquante.',
    'error.rateLimit': 'Trop de requêtes depuis cette IP. Veuillez réessayer plus tard.',

    // Rate Limiting
    'rateLimit.tokens': 'Trop de requêtes de jetons. Veuillez réessayer plus tard.',
    'rateLimit.webhooks': 'Trop de requêtes entrantes vers le point de terminaison des webhooks. Veuillez réessayer plus tard.',

    // Tokens
    'token.created': 'Carte tokenisée avec succès.',
    'token.not.found': 'Jeton introuvable.',
    'token.error': 'Une erreur est survenue lors de la tokenisation de la carte.',

    // Token validation
    'token.invalid.cardNumber': 'Numéro de carte invalide.',
    'token.invalid.cvv': 'Le CVV doit comporter 3 ou 4 chiffres.',
    'token.invalid.expiryMonth': 'expiryMonth doit être une valeur entre 01 et 12.',
    'token.invalid.expiryYear': 'expiryYear doit contenir 4 chiffres.',
    'token.invalid.expiryYear.tooLow': "expiryYear ne peut pas être inférieur à l'année actuelle.",
    'token.invalid.cardholderName.required': 'cardholderName est requis.',
    'token.invalid.cardholderName.tooShort': 'cardholderName doit comporter au moins 2 caractères.',
    'token.invalid.cardholderName.tooLong': 'cardholderName ne doit pas dépasser 64 caractères.',

    // Transactions
    'transaction.created': 'Transaction créée avec succès.',
    'transaction.not.found': 'Transaction introuvable.',
    'transaction.updated': 'Transaction mise à jour avec succès.',
    'transaction.deleted': 'Transaction supprimée avec succès.',
    'transaction.validation': 'Erreur de validation.'
  }
};
