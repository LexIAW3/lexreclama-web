async function routeAdmin({
  req,
  res,
  url,
  nonce,
  getClientIp,
  isAdminIpAllowed,
  logAdminAudit,
  consumeRateLimit,
  rateLimitRules,
  isAdminAuthorized,
  adminUser,
  adminPassword,
  safeEqual,
  sendAdminAuthChallenge,
  handlers,
}) {
  if (req.method === 'GET' && url.pathname === '/admin') {
    const clientIp = getClientIp(req);
    if (!isAdminIpAllowed(clientIp)) {
      logAdminAudit(req, 'ip_denied', 'ip_not_in_allowlist');
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('Forbidden');
      return true;
    }
    const rate = consumeRateLimit(rateLimitRules['/admin'], clientIp);
    if (rate.limited) {
      logAdminAudit(req, 'rate_limited', `retry_after=${rate.retryAfterSec}`);
      res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': String(rate.retryAfterSec) });
      res.end('Demasiadas solicitudes. Intentalo mas tarde.');
      return true;
    }
    await handlers.handleAdmin(req, res, nonce);
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/portal-test-code') {
    const clientIp = getClientIp(req);
    if (!isAdminIpAllowed(clientIp)) {
      res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: 'Forbidden' }));
      return true;
    }
    const rate = consumeRateLimit(rateLimitRules['/api/admin/portal-test-code'], clientIp);
    if (rate.limited) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(rate.retryAfterSec) });
      res.end(JSON.stringify({ error: 'Demasiadas solicitudes' }));
      return true;
    }
    if (!isAdminAuthorized(req, { adminUser, adminPassword, safeEqual })) {
      sendAdminAuthChallenge(res);
      return true;
    }
    await handlers.handleAdminPortalTestCode(req, res, url);
    return true;
  }

  return false;
}

module.exports = {
  routeAdmin,
};
