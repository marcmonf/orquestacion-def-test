const apiUrl = '/iframe-process';

document.getElementById('card-form').addEventListener('submit', async function (e) {
  e.preventDefault();

  const data = {
    cardholderName: document.getElementById('cardholderName').value,
    cardNumber: document.getElementById('cardNumber').value,
    expiryMonth: document.getElementById('expiryMonth').value,
    expiryYear: document.getElementById('expiryYear').value,
    cvv: document.getElementById('cvv').value,
    amount: parseFloat(document.getElementById('amount').value),
    currency: document.getElementById('currency').value,
    method: 'card',
    status: 'approved'
    merchantId: 'demo-merchant',
    transactionType: 'CIT'
  };

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });

    const result = await response.json();

    if (result.success && result.transaction) {
      alert('✅ Payment Successful!\nTransaction ID: ' + result.transaction._id);
      window.parent.postMessage({ status: 'success', data: result.transaction }, '*');
    } else {
      alert(result.message || 'Payment failed.');
      window.parent.postMessage({ status: 'error', message: result.message }, '*');
    }
  } catch (err) {
    console.error('Error submitting form:', err);
    alert('Payment failed due to technical error.');
  }
});
