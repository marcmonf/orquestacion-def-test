const axios = require('axios');

exports.sendToMerchant = async function (callbackUrl, payload) {
  try {
    const response = await axios.post(callbackUrl, payload, {
      headers: { 'Content-Type': 'application/json' }
    });
    console.log("Webhook enviado al merchant:", response.status);
  } catch (error) {
    console.error("Error al enviar webhook:", error.message);
  }
};
