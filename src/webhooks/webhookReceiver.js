const express = require('express');
const router = express.Router();

router.post('/inbound', (req, res) => {
  console.log("Webhook recibido del adquirente:", req.body);
  res.status(200).json({ received: true });
});

module.exports = router;
