// src/utils/cardInfoParser.js
const axios = require('axios');
const logger = require('../utils/logger');

const parseBin = async (cardNumber) => {
  try {
    const bin = cardNumber.slice(0, 8).padEnd(6, '0').slice(0, 6); // Asegura al menos 6 dígitos
    const response = await axios.get(`https://lookup.binlist.net/${bin}`, {
      headers: {
        'Accept-Version': '3'
      }
    });

    const data = response.data;

    return {
      bin,
      brand: data.scheme || null,
      type: data.type || null, // credit / debit
      category: data.category || null, // business / prepaid / etc.
      issuerCountry: data.country?.alpha2 || null,
      isCorporate: data?.category?.toLowerCase() === 'business',
      isPrepaid: data?.prepaid || false,
      issuerName: data.bank?.name || null
    };

  } catch (err) {
    logger.warn('❗️No se pudo analizar el BIN de la tarjeta', { error: err.message });
    return null;
  }
};

module.exports = { parseBin };
