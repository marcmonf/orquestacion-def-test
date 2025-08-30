// src/channels/pms/connectors/cloudbedsConnector.js
const axios = require('axios');
const qs = require('qs');

const CLOUDBEDS_CLIENT_ID = process.env.CLOUDBEDS_CLIENT_ID;
const CLOUDBEDS_CLIENT_SECRET = process.env.CLOUDBEDS_CLIENT_SECRET;
const CLOUDBEDS_GRANT_TYPE = 'client_credentials';
const CLOUDBEDS_BASE_URL = 'https://hotels.cloudbeds.com/api/v1.1';

let tokenCache = { accessToken: null, expiresAt: 0 };

async function authenticate() {
  if (tokenCache.accessToken && Date.now() < tokenCache.expiresAt - 30000) {
    return tokenCache.accessToken;
  }

  const response = await axios.post(`${CLOUDBEDS_BASE_URL}/oauth/token`, qs.stringify({
    client_id: CLOUDBEDS_CLIENT_ID,
    client_secret: CLOUDBEDS_CLIENT_SECRET,
    grant_type: CLOUDBEDS_GRANT_TYPE
  }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

  const { access_token, expires_in } = response.data;
  tokenCache = {
    accessToken: access_token,
    expiresAt: Date.now() + (Number(expires_in || 3600) * 1000)
  };
  return tokenCache.accessToken;
}

async function fetchReservationsPage({ page = 1, pageSize = 50 }) {
  const accessToken = await authenticate();
  const response = await axios.get(`${CLOUDBEDS_BASE_URL}/reservations`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    params: { status: 'confirmed', page, per_page: pageSize }
  });
  const data = response.data?.data || [];
  return Array.isArray(data) ? data : [];
}

async function fetchReservationsPaginated({ maxItems = 500, pageSize = 50 }) {
  const all = [];
  let page = 1;
  while (all.length < maxItems) {
    const batch = await fetchReservationsPage({ page, pageSize });
    if (!batch.length) break;
    all.push(...batch);
    if (batch.length < pageSize) break;
    page += 1;
  }
  // Filtrar las que requieren pago
  return all.filter(r => r.payment_required);
}

module.exports = { authenticate, fetchReservationsPaginated };
