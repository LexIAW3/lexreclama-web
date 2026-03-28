const net = require('net');

function ipToInt(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    value = (value << 8) | n;
  }
  return value >>> 0;
}

function isIpv4InCidr(ip, cidr) {
  const [base, prefixRaw] = String(cidr).split('/');
  const prefix = Number(prefixRaw);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const ipNum = ipToInt(ip);
  const baseNum = ipToInt(base);
  if (ipNum === null || baseNum === null) return false;
  if (prefix === 0) return true;
  const mask = (0xFFFFFFFF << (32 - prefix)) >>> 0;
  return (ipNum & mask) === (baseNum & mask);
}

function getClientIp(req) {
  const headerRealIp = String(req.headers['x-real-ip'] || '').trim();
  const headerForwardedFor = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const socketIp = String(req.socket.remoteAddress || '').trim();
  const candidate = headerRealIp || headerForwardedFor || socketIp || 'unknown';
  const ipv4Mapped = candidate.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  const normalized = ipv4Mapped ? ipv4Mapped[1] : candidate;
  return net.isIP(normalized) ? normalized : 'unknown';
}

function buildAdminIpChecker(allowedIps) {
  const rules = Array.isArray(allowedIps) ? allowedIps.filter(Boolean) : [];
  return function isAdminIpAllowed(ip) {
    if (!ip || ip === 'unknown') return false;
    const kind = net.isIP(ip);
    for (const rule of rules) {
      if (rule === ip) return true;
      if (kind === 4 && rule.includes('/') && isIpv4InCidr(ip, rule)) return true;
    }
    return false;
  };
}

module.exports = {
  getClientIp,
  buildAdminIpChecker,
};
