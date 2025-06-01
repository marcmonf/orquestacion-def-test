const apiUrl = '/iframe-process';

document.addEventListener('DOMContentLoaded', () => {
  const methods = ['card', 'applepay', 'googlepay'];

  methods.forEach(method => {
    const header = document.getElementById(`method-${method}`);
    const content = document.getElementById(`${method}-form`);

    header.addEventListener('click', () => {
      const isOpen = content.classList.contains('show');

      // Cerrar todos
      methods.forEach(m => {
        document.getElementById(`method-${m}`).classList.remove('active');
        document.getElementById(`${m}-form`).classList.remove('show');
      });

      // Mostrar solo si estaba cerrado
      if (!isOpen) {
        header.classList.add('active');
        content.classList.add('show');

        if (method === 'applepay') initApplePayButton();
        if (method === 'googlepay') initGooglePayButton();
      }
    });
  });
});

// Lógica del pago con tarjeta (sin cambios)
document.getElementById('card-payment-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = {
    cardholderName: document.getElementById('cardholderName').value,
    cardNumber: document.getElementById('cardNumber').value,
    expiryMonth: document.getElementById('expiryMonth').value,
    expiryYear: document.getElementById('expiryYear').value,
    cvv: document.getElementById('cvv').value,
    amount: parseFloat(document.getElementById('amount').value),
    currency: document.getElementById('currency').value,
    merchantId: 'demo-merchant',
    method: 'card',
    status: 'approved',
    transactionType: 'CIT'
  };

  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });

  const result = await res.json();
  if (result.success && result.transaction) {
    alert('✅ Pago realizado. ID: ' + result.transaction._id);
  } else {
    alert(result.message || 'Error en el pago.');
  }
});

// Apple Pay (sin cambios)
function initApplePayButton() {
  if (!window.ApplePaySession || !ApplePaySession.canMakePayments()) return;

  const container = document.getElementById('apple-pay-button');
  container.innerHTML = '';

  const button = document.createElement('apple-pay-button');
  button.setAttribute('buttonstyle', 'black');
  button.setAttribute('type', 'plain');
  button.setAttribute('locale', 'es-ES');
  container.appendChild(button);

  button.addEventListener('click', startApplePaySession);
}

function startApplePaySession() {
  const session = new ApplePaySession(3, {
    countryCode: 'ES',
    currencyCode: 'EUR',
    supportedNetworks: ['visa', 'masterCard'],
    merchantCapabilities: ['supports3DS'],
    total: { label: 'Demo Merchant', amount: '99.90' }
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

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'applepay',
        paymentData,
        amount: 99.90,
        currency: 'EUR',
        merchantId: 'demo-merchant',
        transactionType: 'CIT'
      })
    });

    const result = await response.json();
    if (result.success && result.transaction) {
      session.completePayment(ApplePaySession.STATUS_SUCCESS);
      alert('✅ Apple Pay completado');
    } else {
      session.completePayment(ApplePaySession.STATUS_FAILURE);
    }
  };

  session.begin();
}

// Google Pay (simulado correctamente)
function initGooglePayButton() {
  const client = new google.payments.api.PaymentsClient({ environment: 'TEST' });

  const container = document.getElementById('google-pay-button');
  container.innerHTML = '';
  const button = client.createButton({ onClick: onGooglePayButtonClicked });
  container.appendChild(button);
}

async function onGooglePayButtonClicked() {
  const client = new google.payments.api.PaymentsClient({ environment: 'TEST' });

  const paymentData = await client.loadPaymentData({
    apiVersion: 2,
    apiVersionMinor: 0,
    allowedPaymentMethods: [{
      type: 'CARD',
      parameters: {
        allowedAuthMethods: ['PAN_ONLY', 'CRYPTOGRAM_3DS'],
        allowedCardNetworks: ['VISA', 'MASTERCARD']
      },
      tokenizationSpecification: {
        type: 'PAYMENT_GATEWAY',
        parameters: {
          gateway: 'stripe',
          gatewayMerchantId: 'demo_merchant'
        }
      }
    }],
    transactionInfo: {
      totalPriceStatus: 'FINAL',
      totalPrice: '99.90',
      currencyCode: 'EUR',
      countryCode: 'ES'
    },
    merchantInfo: { merchantName: 'Demo Merchant' }
  });

  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      method: 'googlepay',
      paymentData,
      amount: 99.90,
      currency: 'EUR',
      merchantId: 'demo-merchant',
      transactionType: 'CIT'
    })
  });

  const result = await res.json();
  if (result.success && result.transaction) {
    alert('✅ Google Pay completado');
  } else {
    alert(result.message || 'Google Pay falló');
  }
}
