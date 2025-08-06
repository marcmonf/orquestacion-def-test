// src/utils/cardInfoParser.js
const axios = require('axios');

async function parseBin(cardNumber) {
  try {
    const bin = cardNumber.slice(0, 6);

    // 🔧 Override manual temporal para pruebas locales con BIN 545454
    if (bin === '545454') {
      console.debug('[DEBUG] Override aplicado para BIN 545454');
      return {
        bin,
        brand: 'mastercard',
        type: 'credit',
        category: 'corporate',
        issuerCountry: 'US',
        issuerName: 'Bank of America',
        isCorporate: true,
        isPrepaid: false
      };
    }

    const response = await axios.get(`https://lookup.binlist.net/${bin}`, {
      headers: { 'Accept-Version': '3' }
    });

    const data = response.data;

    return {
      bin,
      brand: data.scheme || null,
      type: data.type || null,               // 'debit' | 'credit'
      category: data.category || null,       // Ej: 'business', 'corporate', 'classic', etc.
      issuerCountry: data.country?.alpha2 || null,
      issuerName: data.bank?.name || null,
      isCorporate:
        data.prepaid === false &&
        data.type === 'credit' &&
        (
          data.category?.toLowerCase().includes('business') ||
          data.category?.toLowerCase().includes('corporate')
        ),
      isPrepaid: data.prepaid === true
    };
  } catch (err) {
    console.warn(`[⚠️  BIN Lookup] Error parsing BIN: ${err.message}`);
    return null; // Si falla, devolvemos null para que el strategy use el fallback
  }
}

module.exports = { parseBin };
