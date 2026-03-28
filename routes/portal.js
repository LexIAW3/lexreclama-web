async function routePortalApi({
  req,
  res,
  url,
  getClientIp,
  consumeRateLimit,
  rateLimitRules,
  validateCsrfToken,
  handlers,
}) {
  if (req.method === 'GET' && url.pathname === '/api/portal/me') {
    const clientIp = getClientIp(req);
    const rate = consumeRateLimit(rateLimitRules['/api/portal/me'], clientIp);
    if (rate.limited) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(rate.retryAfterSec) });
      res.end(JSON.stringify({ error: 'Demasiadas solicitudes' }));
      return true;
    }
    await handlers.handlePortalMe(req, res);
    return true;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/portal/cases/') && url.pathname.includes('/documents/')) {
    const clientIp = getClientIp(req);
    const rate = consumeRateLimit(rateLimitRules['/api/portal/documents'], clientIp);
    if (rate.limited) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(rate.retryAfterSec) });
      res.end(JSON.stringify({ error: 'Demasiadas solicitudes' }));
      return true;
    }
    const match = url.pathname.match(/^\/api\/portal\/cases\/([^/]+)\/documents\/([^/]+)$/);
    if (!match) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Ruta no encontrada' }));
      return true;
    }
    const caseId = decodeURIComponent(match[1]);
    const fileId = decodeURIComponent(match[2]);
    await handlers.handlePortalCaseDocumentDownload(req, res, caseId, fileId);
    return true;
  }

  if (req.method === 'POST' && (
    url.pathname === '/api/portal/request-code'
    || url.pathname === '/api/portal/verify-code'
    || url.pathname === '/api/portal/logout'
    || url.pathname.startsWith('/api/portal/cases/')
  )) {
    const clientIp = getClientIp(req);
    const rateLimitPath = url.pathname.startsWith('/api/portal/cases/')
      ? '/api/portal/cases'
      : url.pathname;
    const rule = rateLimitRules[rateLimitPath];
    const rate = consumeRateLimit(rule, clientIp);
    if (rate.limited) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(rate.retryAfterSec) });
      res.end(JSON.stringify({ error: 'Demasiadas solicitudes. Inténtalo más tarde.' }));
      return true;
    }
    if (!await validateCsrfToken(req, res)) return true;
    if (url.pathname === '/api/portal/request-code') {
      await handlers.handlePortalRequestCode(req, res);
      return true;
    }
    if (url.pathname === '/api/portal/verify-code') {
      await handlers.handlePortalVerifyCode(req, res);
      return true;
    }
    if (url.pathname === '/api/portal/logout') {
      await handlers.handlePortalLogout(req, res);
      return true;
    }
    const msgMatch = url.pathname.match(/^\/api\/portal\/cases\/([^/]+)\/messages$/);
    if (msgMatch) {
      const caseId = decodeURIComponent(msgMatch[1]);
      await handlers.handlePortalCaseMessage(req, res, caseId);
      return true;
    }
  }

  return false;
}

module.exports = {
  routePortalApi,
};
