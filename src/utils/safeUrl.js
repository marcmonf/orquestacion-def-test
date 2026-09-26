// src/utils/safeUrl.js
'use strict';
//
// Protección SSRF para las peticiones SALIENTES hacia URLs que decide un tercero
// (webhookUrl del merchant). Sin esto, un merchant podía poner como webhook
// https://127.0.0.1:xxxx/, https://10.0.0.5/ o el endpoint de metadatos de la
// nube y usar a Monetiser para atacar su red interna.
//
// Reglas:
//   - solo https;
//   - el nombre se resuelve por DNS y se rechaza si CUALQUIER dirección es
//     privada, loopback, link-local, CGNAT, multicast o reservada;
//   - la conexión se hace contra la IP ya validada (anti DNS-rebinding).

const dns = require('dns').promises;
const net = require('net');

function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, oct) => (acc << 8) + (parseInt(oct, 10) & 255), 0) >>> 0;
}

const V4_BLOCKED = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([base, bits]) => [ipv4ToInt(base), bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0]);

function isBlockedIPv4(ip) {
  const n = ipv4ToInt(ip);
  return V4_BLOCKED.some(([base, mask]) => ((n & mask) >>> 0) === ((base & mask) >>> 0));
}

function isBlockedIPv6(ip) {
  const v = ip.toLowerCase();
  if (v === '::' || v === '::1') return true;
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIPv4(mapped[1]);
  if (/^f[cd]/.test(v)) return true;          // fc00::/7  (ULA)
  if (/^fe[89ab]/.test(v)) return true;       // fe80::/10 (link-local)
  if (/^ff/.test(v)) return true;             // ff00::/8  (multicast)
  if (v.startsWith('64:ff9b:')) return true;  // NAT64
  if (v.startsWith('2001:db8:')) return true; // documentación
  return false;
}

function isBlockedAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return isBlockedIPv4(address);
  if (family === 6) return isBlockedIPv6(address);
  return true;
}

/**
 * Valida una URL de destino y devuelve { url, address, family } con la IP
 * pública a la que conectar. Lanza Error('blocked_destination:...') si no vale.
 */
async function resolvePublicHttpsTarget(rawUrl) {
  let url;
  try { url = new URL(String(rawUrl)); } catch { throw new Error('blocked_destination:invalid_url'); }
  if (url.protocol !== 'https:') throw new Error('blocked_destination:https_required');
  if (url.username || url.password) throw new Error('blocked_destination:credentials_in_url');

  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses;
  if (net.isIP(host)) {
    addresses = [{ address: host, family: net.isIP(host) }];
  } else {
    try {
      addresses = await dns.lookup(host, { all: true });
    } catch {
      throw new Error('blocked_destination:dns_failure');
    }
  }
  if (!addresses.length) throw new Error('blocked_destination:dns_empty');
  if (addresses.some(a => isBlockedAddress(a.address))) {
    throw new Error('blocked_destination:private_address');
  }
  return { url, address: addresses[0].address, family: addresses[0].family };
}

module.exports = { resolvePublicHttpsTarget, isBlockedAddress };
