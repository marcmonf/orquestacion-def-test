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

  if (isIOS) {
    googlePayBtn.style.display = 'none';
  } else if (isAndroid) {
    applePayBtn.style.display = 'none';
  }

  if (isIOS && window.ApplePaySession && ApplePaySession.canMakePayments()) {
    applePayBtn.addEventListener('click', startApplePaySession);
  }

  if (isAndroid && window.google) {
    googlePayBtn.addEventListener('click', onGooglePayButtonClicked);
  }
});

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
    const successDiv = document.getElementById('success-message');
    successDiv.innerHTML = `
      <strong>✅ ¡Pago realizado con éxito!</strong>
      Importe: ${result.transaction.amount} ${result.transaction.currency}<br>
      ID: <small>${result.transaction._id}</small><br>
      Merchant: <small>${result.transaction.merchantId}</small>
    `;
    successDiv.style.display = 'block';

    document.getElementById('card-form').style.display = 'none';
    document.getElementById('method-card').style.display = 'none';
  } else {
    alert(result.message || 'Error en el pago.');
  }
});

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

window.startApplePaySession = startApplePaySession;
window.onGooglePayButtonClicked = onGooglePayButtonClicked;
