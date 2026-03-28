const crypto = require('crypto');

function generateNonce() {
  return crypto.randomBytes(16).toString('base64url');
}

function safeEqual(a, b) {
  // Hash both values to a fixed-length digest so the comparison is constant-time
  // regardless of input length — avoids timing side-channel that leaks password length.
  const left = crypto.createHash('sha256').update(String(a)).digest();
  const right = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(left, right);
}

module.exports = {
  generateNonce,
  safeEqual,
};
