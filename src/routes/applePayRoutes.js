const express = require('express');
const router = express.Router();
const https = require('https');

router.post('/validate', (req, res) => {
  const { validationURL } = req.body;

  const options = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    }
  };

  const request = https.request(validationURL, options, response => {
    let data = '';
    response.on('data', chunk => data += chunk);
    response.on('end', () => res.json(JSON.parse(data)));
  });

  request.on('error', err => {
    console.error("Error validando Apple Pay:", err);
    res.status(500).send("Error validando Apple Pay");
  });

  request.end();
});

module.exports = router;
