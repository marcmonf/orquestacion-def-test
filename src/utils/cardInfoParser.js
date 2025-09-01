'use strict';
/**
 * Enriquecimiento BIN con timeout y fallback.
 * - Proveedor por defecto: binlist (lookup.binlist.net).
 * - Tiempo máx configurable: BIN_TIMEOUT_MS (por defecto 800 ms).
 * - BIN_OFFLINE=1 desactiva llamadas externas y devuelve mínimos.
 */
const https = require('https');

const PROVIDER = String(process.env.BIN_PROVIDER || 'binlist').toLowerCase();
const TIMEOUT_MS = Number(process.env.BIN_TIMEOUT_MS || 800);
const OFFLINE = String(process.env.BIN_OFFLINE || '0') === '1';

function toBin(num) {
  if (!num) return null;
  const digits = String(num).replace(/\D/g, '');
  // admitimos hasta 8 para IIN extendido; usamos 6 si no hay más
  return digits.slice(0, 8) || null;
}

function mapBinlist(bin, j) {
  const country = j?.country?.alpha2 || j?.country?.name || null;
  const brand   = j?.scheme || j?.brand || null;
  const type    = j?.type || null;
  const level   = j?.prepaid ? 'prepaid' : null;
  const bank    = j?.bank?.name || null;
  const phone   = j?.bank?.phone || null;
  const curr    = j?.country?.currency || null;

  return {
    bin: String(bin),
    cardBrand: brand,
    cardType: type,
    cardLevel: level,
    issuerName: bank,
    issuerCountry: country,
    bankPhone: phone,
    countryCurrency: curr
  };
}

function fetchBinlist(bin) {
  return new Promise((resolve) => {
    const opts = {
      host: 'lookup.binlist.net',
      path: `/${encodeURIComponent(bin)}`,
      method: 'GET',
      headers: { 'Accept-Version': '3' }
    };

    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data || '{}');
          resolve(mapBinlist(bin, json));
        } catch {
          resolve({ bin: String(bin), issuerCountry: null });
        }
      });
    });

    req.on('error', () => resolve({ bin: String(bin), issuerCountry: null }));
    req.setTimeout(TIMEOUT_MS, () => { req.destroy(); resolve({ bin: String(bin), issuerCountry: null }); });
    req.end();
  });
}

async function parseBin(cardNumber) {
  const bin = toBin(cardNumber);
  if (!bin) return null;

  if (OFFLINE) {
    return { bin: String(bin), issuerCountry: null };
  }

  try {
    if (PROVIDER === 'binlist') {
      return await fetchBinlist(bin);
    }
    // Otros proveedores futuros
    return { bin: String(bin), issuerCountry: null };
  } catch {
    return { bin: String(bin), issuerCountry: null };
  }
}

module.exports = { parseBin };
