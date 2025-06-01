const apiUrl = '/iframe-process';

document.addEventListener('DOMContentLoaded', () => {
  const cardHeader = document.getElementById('method-card');
  const cardForm = document.getElementById('card-form');

  // Toggle para tarjeta
  cardHeader.addEventListener('click', () => {
    cardHeader.classList.toggle('active');
    cardForm.classList.toggle('show');
  });

  // Apple Pay
  const appleHeader = document.getElementById('method-applepay');
  appleHeader.addEventListener('click', startApplePaySession);

  // Google Pay
  const googleHeader = document.getElementById('method-googlepay');
  googleHeader.addEventListener('click', onGooglePayButtonClicked);

  initApplePayButton();
  initGooglePayButton();
});

// Procesar formulario tarjeta
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

// Apple Pay (demo)
function initApplePayButton() {
  const container = document.getElementById('apple-pay-button');
  container.innerHTML = '';
  const img = document.createElement('img');
  img.src = '/applepay-custom.png';
  img.alt = 'Apple Pay';
  img.onclick = startApplePaySession;
  container.appendChild(img);
}

function startApplePaySession() {
  alert('🔔 Apple Pay: simulación iniciada');
  // Aquí iría la lógica real si se habilita
}

// Google Pay (demo)
function initGooglePayButton() {
  const container = document.getElementById('google-pay-button');
  container.innerHTML = '';
  const img = document.createElement('img');
  img.src = '/googlepay-custom.png';
  img.alt = 'Google Pay';
  img.onclick = onGooglePayButtonClicked;
  container.appendChild(img);
}

async function onGooglePayButtonClicked() {
  alert('🔔 Google Pay: simulación iniciada');
  // Aquí iría la lógica real si se habilita
}

// Exponer funciones si fueran necesarias
window.startApplePaySession = startApplePaySession;
window.onGooglePayButtonClicked = onGooglePayButtonClicked;
