async function routeCheckoutEndpoints({
  req,
  res,
  url,
  getClientIp,
  consumeRateLimit,
  rateLimitRules,
  validateCsrfToken,
  handlers,
}) {
  if (req.method !== 'POST' || (url.pathname !== '/create-checkout-session' && url.pathname !== '/confirm-checkout')) {
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

  if (url.pathname === '/create-checkout-session') {
    await handlers.handleCreateCheckoutSession(req, res);
    return true;
  }

  await handlers.handleConfirmCheckout(req, res);
  return true;
}

module.exports = {
  routeCheckoutEndpoints,
};
