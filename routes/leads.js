async function routeLeadEndpoints({
  req,
  res,
  url,
  getClientIp,
  consumeRateLimit,
  rateLimitRules,
  validateCsrfToken,
  handlers,
}) {
  if (req.method !== 'POST' || (
    url.pathname !== '/submit-lead'
    && url.pathname !== '/api/lead'
    && url.pathname !== '/api/leads'
    && url.pathname !== '/api/subscribe'
  )) {
    return false;
  }

  const clientIp = getClientIp(req);
  const rule = rateLimitRules[url.pathname];
  const rate = consumeRateLimit(rule, clientIp);
  if (rate.limited) {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(rate.retryAfterSec) });
    res.end(JSON.stringify({ error: 'Demasiadas solicitudes. Inténtalo más tarde.' }));
    return true;
  }
  if (!await validateCsrfToken(req, res)) return true;
  if (url.pathname === '/submit-lead') {
    await handlers.handleSubmitLead(req, res);
    return true;
  }
  if (url.pathname === '/api/lead' || url.pathname === '/api/leads') {
    await handlers.handleApiLead(req, res);
    return true;
  }
  await handlers.handleSubscribe(req, res);
  return true;
}

module.exports = {
  routeLeadEndpoints,
};
