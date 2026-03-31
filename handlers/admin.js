'use strict';

/**
 * DT-3 Fase E — handler de admin extraído de server.js.
 * Factory con DI: recibe dependencias y devuelve handleAdmin + logAdminAudit.
 */

/**
 * @param {object} deps
 * @param {Function} deps.getClientIp
 * @param {string}   deps.adminPassword
 * @param {string}   deps.adminUser
 * @param {Function} deps.isAdminAuthorized
 * @param {Function} deps.safeEqual
 * @param {Function} deps.sendAdminAuthChallenge
 * @param {Function} deps.renderAdminPage
 */
function createAdminHandlers({
  getClientIp,
  adminPassword,
  adminUser,
  isAdminAuthorized,
  safeEqual,
  sendAdminAuthChallenge,
  renderAdminPage,
}) {
  function logAdminAudit(req, outcome, detail = '') {
    const clientIp = getClientIp(req);
    const forwardedFor = String(req.headers['x-forwarded-for'] || '').trim();
    const userAgent = String(req.headers['user-agent'] || '').replace(/[\r\n\t]+/g, ' ').trim();
    const safeDetail = String(detail || '').replace(/[\r\n\t]+/g, ' ').trim();
    const safeXff = forwardedFor.replace(/[\r\n\t]+/g, ' ').trim();
    const detailPart = safeDetail ? ` detail=${safeDetail}` : '';
    const xffPart = safeXff ? ` xff="${safeXff}"` : '';
    console.log(`[audit][admin] outcome=${outcome} ip=${clientIp} method=${req.method} path=${req.url}${detailPart}${xffPart} ua="${userAgent}"`);
  }

  async function handleAdmin(req, res, nonce = '') {
    if (!adminPassword) {
      logAdminAudit(req, 'admin_disabled', 'ADMIN_PASSWORD_missing');
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('ADMIN_PASSWORD is not configured');
      return;
    }

    if (!isAdminAuthorized(req, { adminUser, adminPassword, safeEqual })) {
      logAdminAudit(req, 'auth_failed');
      await new Promise((resolve) => setTimeout(resolve, 300));
      sendAdminAuthChallenge(res);
      return;
    }

    logAdminAudit(req, 'auth_success');
    const html = renderAdminPage(nonce);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
  }

  return { handleAdmin, logAdminAudit };
}

module.exports = { createAdminHandlers };
