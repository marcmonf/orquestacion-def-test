//public/inpage.js

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

  // Prefijar importe y moneda desde el contexto (HostedCheckout)
  const ctx = window.MONETISER_CONTEXT || {};
  const amountInput = document.getElementById('amount');
  const currencyInput = document.getElementById('currency');

  if (amountInput && ctx.amount !== undefined && ctx.amount !== null && ctx.amount !== '') {
    amountInput.value = ctx.amount;
    amountInput.readOnly = true;
  }
  if (currencyInput && ctx.currency) {
    currencyInput.value = ctx.currency;
    currencyInput.readOnly = true;
  }
});

function mostrarMensajeExito(transaction) {
  const ctx = window.MONETISER_CONTEXT || {};
  const decimals =
    typeof ctx.minorUnits === 'number' && Number.isFinite(ctx.minorUnits)
      ? ctx.minorUnits
      : 2;

  const returnUrl = transaction.returnUrl || 'https://orquestacion-def-test.onrender.com';
  const successDiv = document.getElementById('success-message');
  successDiv.innerHTML = `
    <strong>✅ ¡Pago realizado con éxito!</strong>
    Importe: ${Number(transaction.amount).toFixed(decimals)} ${transaction.currency}<br>
    ID: <small>${transaction._id}</small><br>
    Merchant: <small>${transaction.merchantId}</small><br><br>
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

  const ctx = window.MONETISER_CONTEXT || {};

  const amountFromCtx =
    (ctx.amount !== undefined && ctx.amount !== null && ctx.amount !== '')
      ? Number(ctx.amount)
      : parseFloat(document.getElementById('amount').value);

  const currencyFromCtx =
    (ctx.currency && ctx.currency !== '')
      ? ctx.currency
      : document.getElementById('currency').value;

  const merchantIdFromCtx = ctx.merchantId || 'demo-merchant';
  const paymentIdFromCtx  = ctx.paymentId || null;

  const data = {
    cardholderName: document.getElementById('cardholderName').value,
    cardNumber: document.getElementById('cardNumber').value,
    expiryMonth: document.getElementById('expiryMonth').value,
    expiryYear: document.getElementById('expiryYear').value,
    cvv: document.getElementById('cvv').value,
    amount: amountFromCtx,
    currency: currencyFromCtx,
    merchantId: merchantIdFromCtx,
    paymentId: paymentIdFromCtx,
    method: 'card',
    status: 'approved',
    transactionType: 'CIT',
    returnUrl: 'https://orquestacion-def-test.onrender.com/gracias'
  };

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
});

function startApplePaySession() {
  const ctx = window.MONETISER_CONTEXT || {};
  const merchantIdFromCtx = ctx.merchantId || 'demo-merchant';
  const currencyFromCtx = ctx.currency || 'EUR';
  const amountFromCtx =
    (ctx.amount !== undefined && ctx.amount !== null && ctx.amount !== '')
      ? String(ctx.amount)
      : '99.90';

  const session = new ApplePaySession(3, {
    countryCode: 'ES',
    currencyCode: currencyFromCtx,
    supportedNetworks: ['visa', 'masterCard'],
    merchantCapabilities: ['supports3DS'],
    total: { label: merchantIdFromCtx, amount: amountFromCtx }
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
        amount: Number(amountFromCtx),
        currency: currencyFromCtx,
        merchantId: merchantIdFromCtx,
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
  };

  session.begin();
}

async function onGooglePayButtonClicked() {
  const ctx = window.MONETISER_CONTEXT || {};
  const merchantIdFromCtx = ctx.merchantId || 'demo-merchant';
  const currencyFromCtx = ctx.currency || 'EUR';
  const amountFromCtx =
    (ctx.amount !== undefined && ctx.amount !== null && ctx.amount !== '')
      ? String(ctx.amount)
      : '99.90';

  const client = new google.payments.api.PaymentsClient({ environment: 'TEST' });
  const paymentData = await client.loadPaymentData({
    apiVersion: 2,
    apiVersionMinor: 0,
    allowedPaymentMethods: [{
      type: 'CARD',
      parameters: { allowedAuthMethods: ['PAN_ONLY','CRYPTOGRAM_3DS'], allowedCardNetworks: ['VISA','MASTERCARD'] },
      tokenizationSpecification: { type: 'PAYMENT_GATEWAY', parameters: { gateway: 'stripe', gatewayMerchantId: merchantIdFromCtx } }
    }],
    transactionInfo: { totalPriceStatus: 'FINAL', totalPrice: amountFromCtx, currencyCode: currencyFromCtx, countryCode: 'ES' },
    merchantInfo: { merchantName: merchantIdFromCtx }
  });

  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      method: 'googlepay',
      paymentData,
      amount: Number(amountFromCtx),
      currency: currencyFromCtx,
      merchantId: merchantIdFromCtx,
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
}

window.startApplePaySession = startApplePaySession;
window.onGooglePayButtonClicked = onGooglePayButtonClicked;
