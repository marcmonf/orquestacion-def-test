// src/services/binService.js
const axios     = require('axios');
const BinCache  = require('../models/BinCache');

const BINLIST_URL = process.env.BINLIST_URL || 'https://lookup.binlist.net/';

/**
 * Devuelve objeto info BIN (cache-first, API fallback)
 * { bin, brand, type, level, issuerName, issuerCountry, bankPhone, countryCurrency }
 */
async function lookupBin(bin) {
  if (!/^\d{6,8}$/.test(bin)) throw new Error('Invalid BIN');

  // 1. Cache
  let cached = await BinCache.findOne({ bin }).lean();
  if (cached) return cached;

  // 2. API
  const { data } = await axios.get(`${BINLIST_URL}${bin}`);
  const info = {
    bin,
    cardBrand:     data.scheme || null,
    cardType:      data.type || null,
    cardLevel:     data.level || null,
    issuerName:    data.bank?.name || null,
    issuerCountry: data.country?.alpha2 || null,
    bankPhone:     data.bank?.phone || null,
    countryCurrency: data.country?.currency || null,
    updatedAt:     new Date()
  };

  // 3. Guardar cache (TTL 7 días)
  await BinCache.updateOne({ bin }, info, { upsert: true });

  return info;
}

module.exports = { lookupBin };
