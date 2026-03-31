'use strict';

/**
 * Route handler for the IndexNow reindex endpoint.
 * POST /api/indexnow/reindex — triggers IndexNow submission for provided URLs.
 *
 * Returns true if the request was handled, false otherwise.
 */
async function routeIndexNow({
  req,
  res,
  url,
  getClientIp,
  consumeRateLimit,
  rateLimitRules,
  safeEqual,
  indexNowReindexToken,
  validateAndAttachJsonBody,
  submitIndexNow,
}) {
  if (req.method !== 'POST' || url.pathname !== '/api/indexnow/reindex') return false;

  if (!indexNowReindexToken) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'INDEXNOW_REINDEX_TOKEN no configurado' }));
    return true;
  }
  const token = String(req.headers['x-indexnow-token'] || '').trim();
  if (!token || !safeEqual(token, indexNowReindexToken)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No autorizado' }));
    return true;
  }
  const clientIp = getClientIp(req);
  const rate = consumeRateLimit(rateLimitRules['/api/lead'], clientIp);
  if (rate.limited) {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(rate.retryAfterSec) });
    res.end(JSON.stringify({ error: 'Demasiadas solicitudes' }));
    return true;
  }
  if (!(await validateAndAttachJsonBody(req, res))) return true;
  const body = req.parsedBody || {};
  const urls = Array.isArray(body.urls) ? body.urls : [];
  if (!urls.length) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Debes enviar un array `urls`' }));
    return true;
  }
  const result = await submitIndexNow(urls);
  res.writeHead(result.status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(result));
  return true;
}

module.exports = { routeIndexNow };
