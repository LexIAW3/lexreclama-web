function parseBasicAuth(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return null;
  let decoded = '';
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch {
    return null;
  }
  const sep = decoded.indexOf(':');
  if (sep === -1) return null;
  return {
    username: decoded.slice(0, sep),
    password: decoded.slice(sep + 1),
  };
}

function sendAdminAuthChallenge(res) {
  res.writeHead(401, {
    'Content-Type': 'text/plain; charset=utf-8',
    'WWW-Authenticate': 'Basic realm="Lex Admin", charset="UTF-8"',
    'Cache-Control': 'no-store',
  });
  res.end('Authentication required');
}

function isAdminAuthorized(req, { adminUser, adminPassword, safeEqual }) {
  if (!adminPassword) return false;
  const creds = parseBasicAuth(req);
  if (!creds) return false;
  return safeEqual(creds.username, adminUser) && safeEqual(creds.password, adminPassword);
}

module.exports = {
  parseBasicAuth,
  sendAdminAuthChallenge,
  isAdminAuthorized,
};
