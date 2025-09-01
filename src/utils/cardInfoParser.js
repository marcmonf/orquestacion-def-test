'use strict';
/**
 * Enriquecimiento BIN con timeout y fallback seguro.
 * - Proveedor por defecto: binlist (lookup.binlist.net)
 * - Config:
 *   BIN_PROVIDER=binlist | BIN_TIMEOUT_MS=800 | BIN_OFFLINE=0/1
 */
const https = require('https');

const PROVIDER   = String(process.env.BIN_PROVIDER || 'binlist').toLowerCase();
const TIMEOUT_MS = Number(process.env.BIN_TIMEOUT_MS || 800);
const OFFLINE    = String(process.env.BIN_OFFLINE || '0') === '1';

function toBin(num) {
  if (!num) return null;
  const digits = String(num).replace(/\D/g, '');
  return digits.slice(0, 8) || null; // 6–8 dígitos
}

function mapBinlist(bin, j) {
  return {
    bin: String(bin),
    cardBrand: j?.scheme || j?.brand || null,
    cardType: j?.type || null,
    cardLevel: j?.prepaid ? 'prepaid' : null,
    issuerName: j?.bank?.name || null,
    issuerCountry: j?.country?.alpha2 || j?.country?.name || null,
    bankPhone: j?.bank?.phone || null,
    countryCurrency: j?.country?.currency || null
  };
}

function fetchBinlist(bin) {
  return new Promise((resolve) => {
    const req = https.request({
      host: 'lookup.binlist.net',
      path: `/${encodeURIComponent(bin)}`,
      method: 'GET',
      headers: { 'Accept-Version': '3' }
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(mapBinlist(bin, JSON.parse(data || '{}'))); }
        catch { resolve({ bin: String(bin), issuerCountry: null }); }
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
  if (OFFLINE) return { bin: String(bin), issuerCountry: null };

  try {
    if (PROVIDER === 'binlist') return await fetchBinlist(bin);
    return { bin: String(bin), issuerCountry: null };
  } catch {
    return { bin: String(bin), issuerCountry: null };
  }
}

module.exports = { parseBin };
