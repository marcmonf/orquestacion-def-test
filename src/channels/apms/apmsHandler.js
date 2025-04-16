const express = require('express');
const router = express.Router();
const transactionManager = require('../../core/transactionManager');
const paymentSchema = require('../../validators/paymentValidator');

router.post('/payments', async (req, res) => {
  try {
    const { error } = paymentSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }

    const tx = req.body;
    tx.channel = "apms";
    const result = await transactionManager.process(tx);
    return res.status(200).json(result);
  } catch (error) {
    console.error("Error en APM handler:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
