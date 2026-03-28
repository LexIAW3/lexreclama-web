function appendSetCookieHeader(res, cookieValue) {
  const existing = res.getHeader('Set-Cookie');
  if (!existing) {
    res.setHeader('Set-Cookie', cookieValue);
    return;
  }
  if (Array.isArray(existing)) {
    res.setHeader('Set-Cookie', [...existing, cookieValue]);
    return;
  }
  res.setHeader('Set-Cookie', [existing, cookieValue]);
}

function buildPortalSessionCookie(token, maxAgeSeconds, { cookieName, secure }) {
  const flags = [
    `${cookieName}=${encodeURIComponent(token)}`,
    'Path=/api/portal',
    'HttpOnly',
  ];
  if (secure) flags.push('Secure');
  flags.push('SameSite=Strict', `Max-Age=${maxAgeSeconds}`);
  return flags.join('; ');
}

function parsePortalSessionToken(req, { cookieName, parseCookies }) {
  const cookies = parseCookies(req);
  return String(cookies[cookieName] || '').trim();
}

function getPortalSessionFromRequest(req, {
  portalSessions,
  sweepPortalState,
  parsePortalSessionTokenFromRequest,
}) {
  sweepPortalState();
  const token = parsePortalSessionTokenFromRequest(req);
  if (!token) return null;
  const session = portalSessions.get(token);
  if (!session) return null;
  if (session.expiresAtMs <= Date.now()) {
    portalSessions.delete(token);
    return null;
  }
  return { token, session };
}

module.exports = {
  appendSetCookieHeader,
  buildPortalSessionCookie,
  parsePortalSessionToken,
  getPortalSessionFromRequest,
};
