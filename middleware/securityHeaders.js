function applySecurityHeaders({ req, res, url, nonce }) {
  // CORS: allow cross-origin only for public static assets (no API/portal routes)
  const isApiPath = url.pathname.startsWith('/api/') || url.pathname.startsWith('/admin');
  if ((req.method === 'GET' || req.method === 'HEAD') && !isApiPath) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self' https://checkout.stripe.com",
      "connect-src 'self' https://api.stripe.com https://checkout.stripe.com https://www.google-analytics.com https://region1.google-analytics.com https://www.googletagmanager.com",
      `script-src 'self' 'nonce-${nonce}' https://www.googletagmanager.com https://js.stripe.com`,
      `style-src 'self' 'nonce-${nonce}' https://fonts.googleapis.com`,
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: https:",
      "frame-src https://js.stripe.com https://checkout.stripe.com",
      'upgrade-insecure-requests',
    ].join('; '),
  );
}

module.exports = {
  applySecurityHeaders,
};
