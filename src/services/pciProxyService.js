// src/services/pciProxyService.js
'use strict';

/**
 * Servicio para el Proxy PCI de Paylands (pci-proxy-api.paynopain.com).
 *
 * CREDENCIALES: Usa las mismas PAYNOPAIN_API_KEY y PAYNOPAIN_SIGNATURE del gateway,
 * pero la autenticación es diferente: primero hay que hacer POST /customers para
 * obtener un JWT Bearer, y usarlo en todas las llamadas posteriores.
 *
 * FLUJO DE TOKENIZACIÓN (client-side):
 *   1. Servidor llama issueTokenizationToken(reference) → devuelve un token de sesión
 *   2. El token se envía al browser → lo usa la librería ProxyFields de Paylands
 *   3. El usuario introduce el PAN en el sub-iFrame de Paylands (nunca toca Monetiser)
 *   4. ProxyFields.submit() → Paylands almacena el PAN y devuelve confirmación
 *   5. Servidor llama getTokenizationResults(reference) → obtiene el masked PAN + token
 *   6. Ese token se usa como source_uuid para lanzar el cobro en Paylands gateway
 */

const https = require('https');
const URL = require('url').URL;
const logger = require('../utils/logger');

const ENV = process.env.PAYNOPAIN_ENV || 'sandbox';
const PCI_BASE = ENV === 'production'
  ? 'https://pci-proxy-api.paynopain.com/prod'
  : 'https://pci-proxy-api.paynopain.com/sandbox';

// Cache del JWT en memoria (evitar llamar a /customers en cada request)
let _jwtToken = null;
let _jwtObtainedAt = 0;
const JWT_TTL_MS = 23 * 60 * 60 * 1000; // 23h (conservador)

/**
 * Hace una petición HTTP a la API del Proxy PCI.
 */
function pciRequest(method, path, body, bearerToken) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const u = new URL(`${PCI_BASE}${path}`);

    const headers = {
      'Content-Type': 'application/json',
    };
    if (payload) headers['Content-Length'] = String(payload.length);
    if (bearerToken) headers['Authorization'] = `Bearer ${bearerToken}`;

    const opts = {
      hostname: u.hostname,
      port: 443,
      path: u.pathname,
      method,
      headers,
    };

    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Obtiene (o reutiliza desde caché) el JWT Bearer del Proxy PCI.
 * Llama a POST /customers con PAYNOPAIN_API_KEY + PAYNOPAIN_SIGNATURE.
 */
async function getBearerToken() {
  const now = Date.now();

  // Reutilizar si el token está en caché y no ha expirado
  if (_jwtToken && (now - _jwtObtainedAt) < JWT_TTL_MS) {
    return _jwtToken;
  }

  const apiKey = process.env.PAYNOPAIN_API_KEY;
  const signature = process.env.PAYNOPAIN_SIGNATURE;

  if (!apiKey || !signature) {
    throw new Error('PCI_PROXY: PAYNOPAIN_API_KEY o PAYNOPAIN_SIGNATURE no configurados');
  }

  logger.info('PCI_PROXY_AUTH', {
    component: 'pciProxyService',
    event: 'Obteniendo JWT Bearer del Proxy PCI',
  });

  const res = await pciRequest('POST', '/customers', { apiKey, signature });

  if (res.status !== 201 || !res.body?.apiKey) {
    logger.error('PCI_PROXY_AUTH_ERROR', {
      component: 'pciProxyService',
      data: { status: res.status, body: res.body },
    });
    throw new Error(`PCI_PROXY: Error al obtener JWT (status ${res.status})`);
  }

  // El campo "apiKey" en la respuesta de /customers es en realidad el JWT Bearer
  _jwtToken = res.body.apiKey;
  _jwtObtainedAt = now;

  logger.info('PCI_PROXY_AUTH_OK', {
    component: 'pciProxyService',
    event: 'JWT Bearer obtenido correctamente',
  });

  return _jwtToken;
}

/**
 * Emite un token de sesión de tokenización para el browser.
 * Este token se pasa a la librería ProxyFields de Paylands en el iFrame.
 *
 * @param {string} reference - Identificador único (usamos paymentId de Monetiser)
 * @returns {Promise<string>} token de sesión para la librería JS cliente
 */
async function issueTokenizationToken(reference) {
  const bearer = await getBearerToken();

  const res = await pciRequest('POST', `/tokenize/${encodeURIComponent(reference)}`, null, bearer);

  if (res.status !== 201 || !res.body?.token) {
    logger.error('PCI_PROXY_TOKENIZE_ERROR', {
      component: 'pciProxyService',
      data: { reference, status: res.status, body: res.body },
    });
    throw new Error(`PCI_PROXY: Error al emitir token de tokenización (status ${res.status})`);
  }

  logger.info('PCI_PROXY_TOKENIZE_ISSUED', {
    component: 'pciProxyService',
    data: { reference },
  });

  return res.body.token;
}

/**
 * Obtiene los resultados de tokenización del Proxy PCI tras el submit del browser.
 * Devuelve el masked PAN y el token que se usará como source_uuid para el cobro.
 *
 * @param {string} reference - El mismo paymentId usado en issueTokenizationToken
 * @returns {Promise<Object>} { token, pan, expiryMonth, expiryYear, cardHolder, brand, bank, country }
 */
async function getTokenizationResults(reference) {
  const bearer = await getBearerToken();

  const res = await pciRequest('GET', `/card/reference/${encodeURIComponent(reference)}`, null, bearer);

  if (res.status !== 200 || !Array.isArray(res.body) || res.body.length === 0) {
    logger.error('PCI_PROXY_GET_RESULTS_ERROR', {
      component: 'pciProxyService',
      data: { reference, status: res.status, body: res.body },
    });
    throw new Error(`PCI_PROXY: No se encontraron resultados para reference=${reference}`);
  }

  // Puede haber múltiples entries si el usuario intentó varias veces; tomamos el primero
  const result = res.body[0];

  logger.info('PCI_PROXY_GET_RESULTS_OK', {
    component: 'pciProxyService',
    data: { reference, brand: result.brand },
  });

  return result;
}

module.exports = {
  getBearerToken,
  issueTokenizationToken,
  getTokenizationResults,
};
