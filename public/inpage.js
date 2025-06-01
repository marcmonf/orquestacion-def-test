const apiUrl = '/iframe-process';

document.addEventListener('DOMContentLoaded', () => {
  const cardHeader = document.getElementById('method-card');
  const cardForm = document.getElementById('card-form');

  cardHeader.addEventListener('click', () => {
    cardHeader.classList.toggle('active');
    cardForm.classList.toggle('show');
  });
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
    alert('✅ Pago realizado. ID: ' + result.transaction._id);
  } else {
    alert(result.message || 'Error en el pago.');
  }
});

// Apple Pay (simulado)
function startApplePaySession() {
  alert('🔔 Apple Pay simulado');
}

// Google Pay (simulado)
function onGooglePayButtonClicked() {
  alert('🔔 Google Pay simulado');
}

// Exponer funciones globalmente
window.startApplePaySession = startApplePaySession;
window.onGooglePayButtonClicked = onGooglePayButtonClicked;
