// src/utils/cryptoUtils.js
const crypto = require('crypto');

const ENCRYPTION_KEY = Buffer.from(process.env.ENCRYPTION_KEY, 'hex'); // 32 bytes (256 bits)
const IV = Buffer.from(process.env.ENCRYPTION_IV, 'hex'); // 16 bytes (128 bits)

function encryptPan(pan) {
  const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, IV);
  let encrypted = cipher.update(pan, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return encrypted;
}

function decryptPan(encryptedPan) {
  const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, IV);
  let decrypted = decipher.update(encryptedPan, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

module.exports = { encryptPan, decryptPan };
