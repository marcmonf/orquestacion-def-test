// public/inpage.js

// De momento este endpoint es el mock de salida del iframe.
// Más adelante lo reconduciremos al flujo S2S real.
const apiUrl = '/iframe-process';

document.addEventListener('DOMContentLoaded', () => {
  const methodHeader = document.getElementById('method-card');
  const cardForm = document.getElementById('card-form');

  methodHeader.addEventListener('click', () => {
    const isOpen = cardForm.classList.contains('show');
    methodHeader.classList.toggle('active', !isOpen);
    cardForm.classList.toggle('show', !isOpen);
  });

  const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  const isAndroid = /Android/i.test(navigator.userAgent);
  const applePayBtn = document.querySelector('img[alt="Apple Pay"]');
  const googlePayBtn = document.querySelector('img[alt="Google Pay"]');

  if (isIOS) googlePayBtn.style.display = 'none';
  else if (isAndroid) applePayBtn.style.display = 'none';

  if (isIOS && window.ApplePaySession && ApplePaySession.canMakePayments()) {
    applePayBtn.addEventListener('click', startApplePaySession);
  }
  if (isAndroid && window.google) {
    googlePayBtn.addEventListener('click', onGooglePayButtonClicked);
  }

  // Trazas básicas para validar que inyectamos bien los metadatos
  const merchantId = document.getElementById('merchantId')?.value;
  const paymentId  = document.getElementById('paymentId')?.value;
  console.debug('[iframe] merchantId, paymentId:', merchantId, paymentId);
});

function mostrarMensajeExito(transaction) {
  const returnUrl = transaction.returnUrl || 'https://orquestacion-def-test.onrender.com';
  const successDiv = document.getElementById('success-message');

  const amountNumber = Number(transaction.amount);
  const currency = transaction.currency || '';

  successDiv.innerHTML = `
    <strong>✅ ¡Pago realizado con éxito!</strong>
    Importe: ${isNaN(amountNumber) ? '-' : amountNumber.toFixed(2)} ${currency}<br>
    ID: <small>${transaction.paymentId || transaction._id || '-'}</small><br>
    Merchant: <small>${transaction.merchantId || '-'}</small><br><br>
    <button onclick="window.location.href='${returnUrl}'">Volver a la tienda</button>
  `;
  successDiv.style.display = 'block';

  const formCard = document.getElementById('card-form');
  const headerCard = document.getElementById('method-card');
  if (formCard) formCard.style.display = 'none';
  if (headerCard) headerCard.style.display = 'none';
}

document.getElementById('card-payment-form').addEventListener('submit', async (e) => {
  e.preventDefault();

  const merchantId = document.getElementById('merchantId')?.value || 'demo-merchant';
  const paymentId  = document.getElementById('paymentId')?.value || null;

  const data = {
    cardholderName: document.getElementById('cardholderName').value,
    cardNumber: document.getElementById('cardNumber').value,
    expiryMonth: document.getElementById('expiryMonth').value,
    expiryYear: document.getElementById('expiryYear').value,
    cvv: document.getElementById('cvv').value,

    // No enviamos amount ni currency: se toman SIEMPRE de Mongo
    merchantId,
    paymentId,

    method: 'card',
    transactionType: 'CIT',
    returnUrl: 'https://orquestacion-def-test.onrender.com/gracias'
  };

  try {
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });

    const result = await res.json();
    if (result.success && result.transaction) {
      mostrarMensajeExito(result.transaction);
    } else {
      alert(result.message || 'Error en el pago.');
    }
  } catch (err) {
    console.error('Error llamando al endpoint de pago desde el iframe:', err);
    alert('Error en la comunicación con el orquestador.');
  }
});

// APPLE PAY (sigue siendo mock; no toca Mongo ni S2S todavía)

function startApplePaySession() {
  const merchantId = document.getElementById('merchantId')?.value || 'demo-merchant';

  const session = new ApplePaySession(3, {
    countryCode: 'ES',
    currencyCode: 'EUR',
    supportedNetworks: ['visa', 'masterCard'],
    merchantCapabilities: ['supports3DS'],
    total: { label: merchantId || 'Demo Merchant', amount: '99.90' }
  });

  session.onvalidatemerchant = async (event) => {
    const res = await fetch('/apple-pay/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ validationURL: event.validationURL })
    });
    const merchantSession = await res.json();
    session.completeMerchantValidation(merchantSession);
  };

  session.onpaymentauthorized = async (event) => {
    const paymentData = event.payment.token.paymentData;
    try {
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: 'applepay',
          paymentData,
          merchantId,
          transactionType: 'CIT',
          returnUrl: 'https://orquestacion-def-test.onrender.com/gracias'
        })
      });

      const result = await response.json();
      if (result.success && result.transaction) {
        session.completePayment(ApplePaySession.STATUS_SUCCESS);
        mostrarMensajeExito(result.transaction);
      } else {
        session.completePayment(ApplePaySession.STATUS_FAILURE);
        alert(result.message || 'Apple Pay falló');
      }
    } catch (err) {
      console.error('Error en Apple Pay:', err);
      session.completePayment(ApplePaySession.STATUS_FAILURE);
      alert('Error en la comunicación con el orquestador.');
    }
  };

  session.begin();
}

// GOOGLE PAY (igual: mock sin impacto en Mongo por ahora)

async function onGooglePayButtonClicked() {
  const merchantId = document.getElementById('merchantId')?.value || 'demo-merchant';

  const client = new google.payments.api.PaymentsClient({ environment: 'TEST' });
  const paymentData = await client.loadPaymentData({
    apiVersion: 2,
    apiVersionMinor: 0,
    allowedPaymentMethods: [{
      type: 'CARD',
      parameters: {
        allowedAuthMethods: ['PAN_ONLY','CRYPTOGRAM_3DS'],
        allowedCardNetworks: ['VISA','MASTERCARD']
      },
      tokenizationSpecification: {
        type: 'PAYMENT_GATEWAY',
        parameters: { gateway: 'stripe', gatewayMerchantId: 'demo_merchant' }
      }
    }],
    transactionInfo: {
      totalPriceStatus: 'FINAL',
      totalPrice: '99.90',
      currencyCode: 'EUR',
      countryCode: 'ES'
    },
    merchantInfo: { merchantName: merchantId || 'Demo Merchant' }
  });

  try {
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'googlepay',
        paymentData,
        merchantId,
        transactionType: 'CIT',
        returnUrl: 'https://orquestacion-def-test.onrender.com/gracias'
      })
    });

    const result = await res.json();
    if (result.success && result.transaction) {
      mostrarMensajeExito(result.transaction);
    } else {
      alert(result.message || 'Google Pay falló');
    }
  } catch (err) {
    console.error('Error en Google Pay:', err);
    alert('Error en la comunicación con el orquestador.');
  }
}

window.startApplePaySession = startApplePaySession;
window.onGooglePayButtonClicked = onGooglePayButtonClicked;
