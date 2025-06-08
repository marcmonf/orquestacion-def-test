// src/channels/pms/connectors/cloudbedsConnector.js
const axios = require('axios');
const qs = require('qs');

const CLOUDbeds_CLIENT_ID = process.env.CLOUDBEDS_CLIENT_ID;
const CLOUDbeds_CLIENT_SECRET = process.env.CLOUDBEDS_CLIENT_SECRET;
const CLOUDBEDS_GRANT_TYPE = 'client_credentials';
const CLOUDBEDS_BASE_URL = 'https://hotels.cloudbeds.com/api/v1.1';

let accessToken = null;

const authenticate = async () => {
  try {
    const response = await axios.post(`${CLOUDBEDS_BASE_URL}/oauth/token`, qs.stringify({
      client_id: CLOUDbeds_CLIENT_ID,
      client_secret: CLOUDbeds_CLIENT_SECRET,
      grant_type: CLOUDBEDS_GRANT_TYPE
    }), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    accessToken = response.data.access_token;
    return accessToken;
  } catch (error) {
    console.error('Error authenticating with Cloudbeds:', error.message);
    throw new Error('cloudbeds.auth.error');
  }
};

const fetchReservations = async () => {
  try {
    if (!accessToken) {
      await authenticate();
    }

    const response = await axios.get(`${CLOUDBEDS_BASE_URL}/reservations`, {
      headers: {
        Authorization: `Bearer ${accessToken}`
      },
      params: {
        status: 'confirmed'
      }
    });

    const reservations = response.data.data || [];

    // Solo retornamos reservas con payment_required
    return reservations.filter(res => res.payment_required);
  } catch (error) {
    console.error('Error fetching reservations from Cloudbeds:', error.message);
    throw new Error('cloudbeds.fetch.error');
  }
};

module.exports = {
  fetchReservations
};
