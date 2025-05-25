module.exports = {
  en: {
    // General
    'error.internal': 'Internal server error.',
    'error.unexpected': 'An unexpected error occurred on the server.',
    'error.invalidApiKey': 'Invalid or missing API key.',
    'error.rateLimit': 'Too many requests from this IP. Please try again later.',
    'error.notFound': 'Route not found.',
    'error.insufficientPermissions': 'Insufficient permissions for this resource.',

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
    'token.invalid.cardNumberOrCvv': 'Card number and CVV do not match expected format for the detected card scheme.',

    // Transactions
    'transaction.created': 'Transaction successfully created.',
    'transaction.not.found': 'Transaction not found.',
    'transaction.updated': 'Transaction successfully updated.',
    'transaction.deleted': 'Transaction successfully deleted.',
    'transaction.validation': 'Validation error.',
    'transaction.fetch.error': 'Error fetching transactions.',
    'transaction.create.error': 'Error creating transaction.',
    'transaction.update.error': 'Error updating transaction.',
    'transaction.delete.error': 'Error deleting transaction.',
    'transaction.analytics.volume.error': 'Error calculating transaction volume.',
    'transaction.analytics.approvalRate.error': 'Error calculating approval rate.',
    'transaction.analytics.averageMsc.error': 'Error calculating average MSC.',
    'transaction.analytics.summary.error': 'Error generating transaction summary.',
    'transaction.invalid.amount': 'Amount must be a positive number.',
    'transaction.invalid.currency': 'Currency must be a 3-letter string.',
    'transaction.invalid.method': 'Payment method must be a valid string.',
    'transaction.invalid.status': 'Status must be one of: approved, declined or pending.',
    'transaction.invalid.merchantId': 'Merchant ID must be a valid string.',
    'transaction.invalid.cardholderName': 'Cardholder name must be between 2 and 64 characters.',
    'transaction.invalid.expiryMonth': 'Expiry month must be a value between 01 and 12.',
    'transaction.invalid.expiryYear': 'Expiry year must be a 4-digit number.',
    'transaction.invalid.expiryYear.tooLow': 'Expiry year cannot be in the past.',
    'transaction.invalid.recurrenceId.required': 'recurrenceId is required for this type of transaction.',
    'transaction.invalid.mit.noMatch': 'No previous CIT found linked to this recurrenceId and token.',
    'transaction.invalid.cardNumber': 'Card number must be 13 to 19 digits.',
    'transaction.invalid.cardNumber.required': 'Card number is required for CIT transactions.',
    'transaction.invalid.cvv': 'CVV must be 3 or 4 digits.',
    'transaction.invalid.cvv.required': 'CVV is required for CIT transactions.',
    'recurrentProfiles.fetch.error': 'Error fetching recurrent profiles.',

    // Others
    'transaction.invalid.phone': 'The phone number is invalid.',
    'transaction.invalid.phone.mbway.required': 'The phone number is required for MB WAY.',
    'transaction.invalid.phone.bizum.required': 'The phone number is required for Bizum.',
    'transaction.invalid.currency.pix.required': 'Pix payments require BRL as the currency.',

    // Health
    'health.ok': 'API operational'
  },

  es: {
    // General
    'error.internal': 'Error interno del servidor.',
    'error.unexpected': 'Ocurrió un error inesperado en el servidor.',
    'error.invalidApiKey': 'Clave API inválida o ausente.',
    'error.rateLimit': 'Demasiadas peticiones desde esta IP. Intenta nuevamente más tarde.',
    'error.notFound': 'Ruta no encontrada.',
    'error.insufficientPermissions': 'Permisos insuficientes para acceder a este recurso.',

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
    'token.invalid.cardNumberOrCvv': 'El número de tarjeta y el CVV no coinciden con el formato esperado para el esquema detectado.',

    // Transacciones
    'transaction.created': 'Transacción creada correctamente.',
    'transaction.not.found': 'Transacción no encontrada.',
    'transaction.updated': 'Transacción actualizada correctamente.',
    'transaction.deleted': 'Transacción eliminada correctamente.',
    'transaction.validation': 'Error de validación.',
    'transaction.fetch.error': 'Error al obtener las transacciones.',
    'transaction.create.error': 'Error al crear la transacción.',
    'transaction.update.error': 'Error al actualizar la transacción.',
    'transaction.delete.error': 'Error al eliminar la transacción.',
    'transaction.analytics.volume.error': 'Error al calcular el volumen de transacciones.',
    'transaction.analytics.approvalRate.error': 'Error al calcular la tasa de aprobación.',
    'transaction.analytics.averageMsc.error': 'Error al calcular el MSC promedio.',
    'transaction.analytics.summary.error': 'Error al generar el resumen de transacciones.',
    'transaction.invalid.amount': 'El monto debe ser un número positivo.',
    'transaction.invalid.currency': 'La moneda debe ser un string de 3 letras.',
    'transaction.invalid.method': 'El método de pago debe ser un texto válido.',
    'transaction.invalid.status': 'El estado debe ser uno de: approved, declined o pending.',
    'transaction.invalid.merchantId': 'El ID del comercio debe ser un texto válido.',
    'transaction.invalid.cardholderName': 'El nombre del titular debe tener entre 2 y 64 caracteres.',
    'transaction.invalid.expiryMonth': 'El mes de vencimiento debe estar entre 01 y 12.',
    'transaction.invalid.expiryYear': 'El año de vencimiento debe tener 4 dígitos.',
    'transaction.invalid.expiryYear.tooLow': 'El año de vencimiento no puede ser menor al actual.',
    'transaction.invalid.recurrenceId.required': 'recurrenceId es obligatorio para este tipo de transacción.',
    'transaction.invalid.mit.noMatch': 'No se encontró una CIT anterior vinculada con este recurrenceId y token.',
    'transaction.invalid.cardNumber': 'El número de tarjeta debe tener entre 13 y 19 dígitos.',
    'transaction.invalid.cardNumber.required': 'El número de tarjeta es obligatorio para transacciones CIT.',
    'transaction.invalid.cvv': 'El CVV debe tener 3 o 4 dígitos.',
    'transaction.invalid.cvv.required': 'El CVV es obligatorio para transacciones CIT.',
    'recurrentProfiles.fetch.error': 'Error al obtener perfiles recurrentes.',
   
    // ...otras claves
    'transaction.invalid.phone': 'El número de teléfono es inválido.',
    'transaction.invalid.phone.mbway.required': 'El número de teléfono es obligatorio para MB WAY.',
    'transaction.invalid.phone.bizum.required': 'El número de teléfono es obligatorio para Bizum.',
    'transaction.invalid.currency.pix.required': 'Los pagos con Pix requieren que la moneda sea BRL.',

    // Health
    'health.ok': 'API operativa'
  },

  fr: {
    // General
    'error.internal': 'Erreur interne du serveur.',
    'error.unexpected': 'Une erreur inattendue est survenue sur le serveur.',
    'error.invalidApiKey': 'Clé API invalide ou manquante.',
    'error.rateLimit': 'Trop de requêtes depuis cette IP. Veuillez réessayer plus tard.',
    'error.notFound': 'Route introuvable.',
    'error.insufficientPermissions': "Permissions insuffisantes pour accéder à cette ressource.",

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
    'token.invalid.cardNumberOrCvv': 'Le numéro de carte et le CVV ne correspondent pas au format attendu pour le schéma détecté.',

    // Transactions
    'transaction.created': 'Transaction créée avec succès.',
    'transaction.not.found': 'Transaction introuvable.',
    'transaction.updated': 'Transaction mise à jour avec succès.',
    'transaction.deleted': 'Transaction supprimée avec succès.',
    'transaction.validation': 'Erreur de validation.',
    'transaction.fetch.error': 'Erreur lors de la récupération des transactions.',
    'transaction.create.error': 'Erreur lors de la création de la transaction.',
    'transaction.update.error': 'Erreur lors de la mise à jour de la transaction.',
    'transaction.delete.error': 'Erreur lors de la suppression de la transaction.',
    'transaction.analytics.volume.error': 'Erreur lors du calcul du volume des transactions.',
    'transaction.analytics.approvalRate.error': "Erreur lors du calcul du taux d'approbation.",
    'transaction.analytics.averageMsc.error': "Erreur lors du calcul du MSC moyen.",
    'transaction.analytics.summary.error': 'Erreur lors de la génération du résumé des transactions.',
    'transaction.invalid.amount': 'Le montant doit être un nombre positif.',
    'transaction.invalid.currency': 'La devise doit être une chaîne de 3 lettres.',
    'transaction.invalid.method': 'Le mode de paiement doit être une chaîne valide.',
    'transaction.invalid.status': 'Le statut doit être : approved, declined ou pending.',
    'transaction.invalid.merchantId': "L'identifiant du marchand doit être une chaîne valide.",
    'transaction.invalid.cardholderName': 'Le nom du titulaire doit comporter entre 2 et 64 caractères.',
    'transaction.invalid.expiryMonth': 'Le mois d’expiration doit être compris entre 01 et 12.',
    'transaction.invalid.expiryYear': "L'année d’expiration doit comporter 4 chiffres.",
    'transaction.invalid.expiryYear.tooLow': "L'année d’expiration ne peut pas être inférieure à l’année actuelle.",
    'transaction.invalid.recurrenceId.required': 'recurrenceId est requis pour ce type de transaction.',
    'transaction.invalid.mit.noMatch': 'Aucune CIT précédente liée à ce recurrenceId et ce token n’a été trouvée.',
    'transaction.invalid.cardNumber': 'Le numéro de carte doit comporter entre 13 et 19 chiffres.',
    'transaction.invalid.cardNumber.required': 'Le numéro de carte est requis pour les transactions CIT.',
    'transaction.invalid.cvv': 'Le CVV doit comporter 3 ou 4 chiffres.',
    'transaction.invalid.cvv.required': 'Le CVV est requis pour les transactions CIT.',
    'recurrentProfiles.fetch.error': 'Erreur lors de la récupération des profils récurrents.',

    // autres
    'transaction.invalid.phone': 'Le numéro de téléphone est invalide.',
    'transaction.invalid.phone.mbway.required': 'Le numéro de téléphone est requis pour MB WAY.',
    'transaction.invalid.phone.bizum.required': 'Le numéro de téléphone est requis pour Bizum.',
    'transaction.invalid.currency.pix.required': 'Les paiements par Pix nécessitent la devise BRL.',

    // Health
    'health.ok': 'API opérationnelle'
  },
    
    pt: {
    // Geral
    'error.internal': 'Erro interno no servidor.',
    'error.unexpected': 'Ocorreu um erro inesperado no servidor.',
    'error.invalidApiKey': 'Chave API inválida ou ausente.',
    'error.rateLimit': 'Muitas solicitações deste IP. Tente novamente mais tarde.',
    'error.notFound': 'Rota não encontrada.',
    'error.insufficientPermissions': 'Permissões insuficientes para acessar este recurso.',

    // Rate Limiting
    'rateLimit.tokens': 'Muitas solicitações de token. Tente novamente mais tarde.',
    'rateLimit.webhooks': 'Muitas chamadas recebidas para o endpoint de webhooks. Tente novamente mais tarde.',

    // Tokens
    'token.created': 'Cartão tokenizado com sucesso.',
    'token.not.found': 'Token não encontrado.',
    'token.error': 'Ocorreu um erro ao tokenizar o cartão.',

    // Validação de Token
    'token.invalid.cardNumber': 'Número de cartão inválido.',
    'token.invalid.cvv': 'O CVV deve conter 3 ou 4 dígitos.',
    'token.invalid.expiryMonth': 'expiryMonth deve estar entre 01 e 12.',
    'token.invalid.expiryYear': 'expiryYear deve conter 4 dígitos.',
    'token.invalid.expiryYear.tooLow': 'expiryYear não pode estar no passado.',
    'token.invalid.cardholderName.required': 'cardholderName é obrigatório.',
    'token.invalid.cardholderName.tooShort': 'cardholderName deve ter pelo menos 2 caracteres.',
    'token.invalid.cardholderName.tooLong': 'cardholderName não deve ultrapassar 64 caracteres.',
    'token.invalid.cardNumberOrCvv': 'O número do cartão e o CVV não correspondem ao formato esperado.',

    // Transações
    'transaction.created': 'Transação criada com sucesso.',
    'transaction.not.found': 'Transação não encontrada.',
    'transaction.updated': 'Transação atualizada com sucesso.',
    'transaction.deleted': 'Transação excluída com sucesso.',
    'transaction.validation': 'Erro de validação.',
    'transaction.fetch.error': 'Erro ao obter transações.',
    'transaction.create.error': 'Erro ao criar a transação.',
    'transaction.update.error': 'Erro ao atualizar a transação.',
    'transaction.delete.error': 'Erro ao excluir a transação.',
    'transaction.analytics.volume.error': 'Erro ao calcular o volume de transações.',
    'transaction.analytics.approvalRate.error': 'Erro ao calcular a taxa de aprovação.',
    'transaction.analytics.averageMsc.error': 'Erro ao calcular o MSC médio.',
    'transaction.analytics.summary.error': 'Erro ao gerar o resumo das transações.',
    'transaction.invalid.amount': 'O valor deve ser um número positivo.',
    'transaction.invalid.currency': 'A moeda deve conter 3 letras.',
    'transaction.invalid.method': 'O método de pagamento deve ser uma string válida.',
    'transaction.invalid.status': 'O status deve ser: approved, declined ou pending.',
    'transaction.invalid.merchantId': 'O ID do comerciante deve ser uma string válida.',
    'transaction.invalid.cardholderName': 'O nome do titular deve ter entre 2 e 64 caracteres.',
    'transaction.invalid.expiryMonth': 'O mês de validade deve estar entre 01 e 12.',
    'transaction.invalid.expiryYear': 'O ano de validade deve conter 4 dígitos.',
    'transaction.invalid.expiryYear.tooLow': 'O ano de validade não pode ser inferior ao atual.',
    'transaction.invalid.recurrenceId.required': 'recurrenceId é obrigatório para este tipo de transação.',
    'transaction.invalid.mit.noMatch': 'Nenhuma CIT anterior encontrada com este recurrenceId e token.',
    'transaction.invalid.cardNumber': 'O número do cartão deve conter entre 13 e 19 dígitos.',
    'transaction.invalid.cardNumber.required': 'O número do cartão é obrigatório para transações CIT.',
    'transaction.invalid.cvv': 'O CVV deve conter 3 ou 4 dígitos.',
    'transaction.invalid.cvv.required': 'O CVV é obrigatório para transações CIT.',
    'recurrentProfiles.fetch.error': 'Erro ao obter perfis recorrentes.',

    // Específicos APM
    'transaction.invalid.phone': 'O número de telefone é inválido.',
    'transaction.invalid.phone.mbway.required': 'O número de telefone é obrigatório para MB WAY.',
    'transaction.invalid.phone.bizum.required': 'O número de telefone é obrigatório para Bizum.',
    'transaction.invalid.currency.pix.required': 'Pagamentos com Pix requerem a moeda BRL.',

    // Saúde
    'health.ok': 'API operacional'
  }
}

};
