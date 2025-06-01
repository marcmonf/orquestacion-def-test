const apiUrl = '/iframe-process';

function toggleMethod(method) {
  const methods = ['card', 'applepay', 'googlepay'];

  const targetButton = document.getElementById(`method-${method}`);
  const targetForm = document.getElementById(`${method}-form`);

  const isAlreadyActive = targetButton.classList.contains('active');

  // Cierra todos
  methods.forEach(id => {
    document.getElementById(`method-${id}`).classList.remove('active');
    document.getElementById(`${id}-form`).classList.remove('active');
  });

  // Si el que clicamos no estaba activo, lo abrimos
  if (!isAlreadyActive) {
    targetButton.classList.add('active');
    targetForm.classList.add('active');

    if (method === 'applepay') initApplePayButton();
    if (method === 'googlepay') initGooglePayButton();
  }
}

window.toggleMethod = toggleMethod;

// Enviar pago con tarjeta
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

  try {
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });

    const result = await res.json();
    if (result.success && result.transaction) {
      alert(`✅ Pago realizado. ID: ${result.transaction._id}`);
      window.parent.postMessage({ status: 'success', data: result.transaction }, '*');
    } else {
      alert(result.message || 'Error en el pago.');
      window.parent.postMessage({ status: 'error', message: result.message }, '*');
    }
  } catch (err) {
    alert('Error técnico al procesar el pago.');
    console.error(err);
  }
});

// Apple Pay
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
  const request = {
    countryCode: 'ES',
    currencyCode: 'EUR',
    supportedNetworks: ['visa', 'masterCard', 'amex'],
    merchantCapabilities: ['supports3DS'],
    total: { label: 'Demo Merchant', amount: '99.90' }
  };

  const session = new ApplePaySession(3, request);

  session.onvalidatemerchant = async (event) => {
    try {
      const res = await fetch('/apple-pay/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ validationURL: event.validationURL })
      });
      const merchantSession = await res.json();
      session.completeMerchantValidation(merchantSession);
    } catch (err) {
      console.error('Apple Pay validation error:', err);
      session.abort();
    }
  };

  session.onpaymentauthorized = async (event) => {
    const paymentData = event.payment.token.paymentData;

    const payload = {
      method: 'applepay',
      paymentData,
      amount: 99.90,
      currency: 'EUR',
      merchantId: 'demo-merchant',
      transactionType: 'CIT'
    };

    try {
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const result = await res.json();
      if (result.success && result.transaction) {
        session.completePayment(ApplePaySession.STATUS_SUCCESS);
        alert('✅ Apple Pay completado');
        window.parent.postMessage({ status: 'success', data: result.transaction }, '*');
      } else {
        session.completePayment(ApplePaySession.STATUS_FAILURE);
        alert(result.message || 'Apple Pay falló');
      }
    } catch (err) {
      console.error(err);
      session.completePayment(ApplePaySession.STATUS_FAILURE);
    }
  };

  session.begin();
}

// Google Pay
function initGooglePayButton() {
  const client = new google.payments.api.PaymentsClient({ environment: 'TEST' });

  const button = client.createButton({ onClick: onGooglePayButtonClicked });
  const container = document.getElementById('google-pay-button');
  container.innerHTML = '';
  container.appendChild(button);
}

async function onGooglePayButtonClicked() {
  const client = new google.payments.api.PaymentsClient({ environment: 'TEST' });

  const request = {
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
    merchantInfo: {
      merchantName: 'Demo Merchant'
    }
  };

  try {
    const paymentData = await client.loadPaymentData(request);

    const payload = {
      method: 'googlepay',
      paymentData,
      amount: 99.90,
      currency: 'EUR',
      merchantId: 'demo-merchant',
      transactionType: 'CIT'
    };

    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const result = await res.json();
    if (result.success && result.transaction) {
      alert('✅ Google Pay completado');
      window.parent.postMessage({ status: 'success', data: result.transaction }, '*');
    } else {
      alert(result.message || 'Google Pay falló');
    }
  } catch (err) {
    console.error('Google Pay error:', err);
    alert('Google Pay error técnico');
  }
}
