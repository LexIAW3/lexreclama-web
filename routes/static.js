function routeStaticMeta({
  req,
  res,
  url,
  getClientIp,
  consumeRateLimit,
  rateLimitRules,
  siteUrl,
  primaryHost,
  sendCompressed,
  buildSitemapXml,
}) {
  if (req.method === 'GET' && url.pathname === '/robots.txt') {
    const clientIp = getClientIp(req);
    const rate = consumeRateLimit(rateLimitRules['/robots.txt'], clientIp);
    if (rate.limited) {
      res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': String(rate.retryAfterSec) });
      res.end('Too many requests');
      return true;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
    res.end(`User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /portal-cliente/\nDisallow: /social-templates/\nSitemap: ${siteUrl}/sitemap.xml\n`);
    return true;
  }

  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/.well-known/security.txt') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=86400' });
    res.end([
      'Contact: mailto:hola@lexreclama.es',
      'Expires: 2027-03-28T00:00:00.000Z',
      'Preferred-Languages: es, en',
      `Canonical: https://${primaryHost}/.well-known/security.txt`,
    ].join('\n') + '\n');
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/sitemap.xml') {
    const clientIp = getClientIp(req);
    const rate = consumeRateLimit(rateLimitRules['/sitemap.xml'], clientIp);
    if (rate.limited) {
      res.writeHead(429, { 'Content-Type': 'application/xml; charset=utf-8', 'Retry-After': String(rate.retryAfterSec) });
      res.end('<error>Too many requests</error>');
      return true;
    }
    const sitemapHeaders = { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=300' };
    sendCompressed(req, res, sitemapHeaders, Buffer.from(buildSitemapXml()));
    return true;
  }

  return false;
}

module.exports = {
  routeStaticMeta,
};
