function parseCookies(req) {
  const header = String(req.headers.cookie || '');
  if (!header) return {};
  return header.split(';').reduce((acc, pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return acc;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    try {
      acc[key] = decodeURIComponent(value);
    } catch {
      acc[key] = value;
    }
    return acc;
  }, {});
}

function createCsrfManager({
  cookieName,
  ttlMs,
  randomToken,
  safeEqual,
  parseBody,
}) {
  const issuedTokens = new Map();

  function sweepCsrfTokens() {
    const now = Date.now();
    for (const [token, expiresAtMs] of issuedTokens) {
      if (expiresAtMs <= now) issuedTokens.delete(token);
    }
  }

  function getOrCreateCsrfToken(req, res) {
    sweepCsrfTokens();
    const cookies = parseCookies(req);
    const cookieToken = String(cookies[cookieName] || '').trim();
    const now = Date.now();
    const activeExpiry = cookieToken ? issuedTokens.get(cookieToken) : 0;
    if (cookieToken && activeExpiry > now) {
      return cookieToken;
    }

    const token = randomToken();
    issuedTokens.set(token, now + ttlMs);

    const forwardedProto = String(req.headers['x-forwarded-proto'] || '')
      .split(',')[0]
      .trim()
      .toLowerCase();
    const secureCookie = forwardedProto === 'https';
    const maxAge = Math.floor(ttlMs / 1000);
    const cookieParts = [
      `${cookieName}=${encodeURIComponent(token)}`,
      'Path=/',
      'SameSite=Strict',
      `Max-Age=${maxAge}`,
    ];
    if (secureCookie) cookieParts.push('Secure');
    res.setHeader('Set-Cookie', cookieParts.join('; '));
    return token;
  }

  function validateCsrfToken(req, res) {
    return (async () => {
      const okBody = await parseBody(req, res);
      if (!okBody) return false;
      sweepCsrfTokens();

      const cookies = parseCookies(req);
      const cookieToken = String(cookies[cookieName] || '').trim();
      const bodyToken = String(req.parsedBody?.csrfToken || '').trim();
      const known = bodyToken ? issuedTokens.get(bodyToken) : 0;
      const validWindow = known > Date.now();

      if (!cookieToken || !bodyToken || !safeEqual(cookieToken, bodyToken) || !validWindow) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'CSRF token inválido' }));
        return false;
      }
      return true;
    })();
  }

  return {
    sweepCsrfTokens,
    getOrCreateCsrfToken,
    validateCsrfToken,
  };
}

module.exports = {
  parseCookies,
  createCsrfManager,
};
