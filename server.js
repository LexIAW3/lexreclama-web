/**
 * Landing page server for the despacho.
 * Serves static files and proxies lead form submissions to Paperclip.
 */
'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const { URL } = require('url');
const { generateNonce } = require('./utils/crypto');
const { getClientIp } = require('./utils/ip');
const { applySecurityHeaders } = require('./middleware/securityHeaders');
const { routePortalApi } = require('./routes/portal');
const { routeAdmin } = require('./routes/admin');
const { routeLeadEndpoints } = require('./routes/leads');
const { routeCheckoutEndpoints } = require('./routes/checkout');
const { routeStaticMeta } = require('./routes/static');
const { routeStaticFiles } = require('./routes/static-files');
const { routeIndexNow } = require('./routes/indexnow');
const { PILLAR_PAGES } = require('./config/pillarPages');
const { RATE_LIMIT_RULES } = require('./config/rateLimitRules');
const { MIME } = require('./config/mime');

const {
  PORT, STATIC_DIR, SITE_URL, PRIMARY_HOST, SECONDARY_HOST, APP_HOST,
  INDEXNOW_KEY, INDEXNOW_REINDEX_TOKEN, BLOG_REDIRECTS, COMPRESSIBLE_EXTS,
  BLOCKED_PREFIXES, BLOCKED_FILENAMES,
  ADMIN_ALLOWED_IPS, GA4_MEASUREMENT_ID, ADMIN_USER, ADMIN_PASSWORD,
  PAPERCLIP_API, OCR_SERVER,
  fetchWithTimeout, sendCompressed, validateAndAttachJsonBody,
  getOrCreateCsrfToken, validateCsrfToken, consumeRateLimit,
  injectRuntimeSnippets, renderBlogIndex, renderPillarPage, handleLegalPage, send404,
  submitIndexNow, buildSitemapXml,
  isAdminIpAllowed, isAdminAuthorized, safeEqual, sendAdminAuthChallenge,
  logAdminAudit, handleAdmin,
  handleCreateCheckoutSession, handleConfirmCheckout,
  handleSubmitLead, handleApiLead, handleSubscribe,
  handleAdminPortalTestCode, handlePortalRequestCode, handlePortalVerifyCode,
  handlePortalMe, handlePortalLogout, handlePortalCaseMessage, handlePortalCaseDocumentDownload,
  sweepAllMaps,
} = require('./bootstrap');

function normalizePathname(pathname) {
  if (!pathname || pathname === '/') return '/';
  return pathname.endsWith('/') ? pathname : `${pathname}/`;
}

const server = http.createServer(async (req, res) => {
  try {
  const url = new URL(req.url.replace(/^\/\/+/, '/'), `http://localhost:${PORT}`);
  const normalizedPath = normalizePathname(url.pathname);
  const host = (req.headers.host || '').split(':')[0].toLowerCase();
  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/health') {
    const clientIp = getClientIp(req);
    const rate = consumeRateLimit(RATE_LIMIT_RULES['/health'], clientIp);
    if (rate.limited) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(rate.retryAfterSec) });
      res.end(JSON.stringify({ error: 'Demasiadas solicitudes' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    res.end(JSON.stringify({ ok: true, uptime: Math.floor(process.uptime()) }));
    return;
  }
  const csrfToken = getOrCreateCsrfToken(req, res);
  const nonce = generateNonce();
  applySecurityHeaders({ req, res, url, nonce });

  if ((req.method === 'GET' || req.method === 'HEAD') && (host === SECONDARY_HOST || host === `www.${SECONDARY_HOST}`)) {
    const target = `https://${PRIMARY_HOST}${url.pathname}${url.search}`;
    res.writeHead(301, { Location: target, 'Cache-Control': 'public, max-age=3600' });
    res.end();
    return;
  }

  // Serve customer portal at app host root without changing URL.
  if (req.method === 'GET' && host === APP_HOST && url.pathname === '/') {
    const portalPath = path.join(STATIC_DIR, 'portal-cliente', 'index.html');
    const data = await fs.promises.readFile(portalPath, 'utf8');
    const html = injectRuntimeSnippets(data, csrfToken, nonce);
    sendCompressed(
      req,
      res,
      { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      Buffer.from(html),
    );
    return;
  }

  if ((req.method === 'GET' || req.method === 'HEAD') && BLOG_REDIRECTS[normalizedPath]) {
    const target = `${BLOG_REDIRECTS[normalizedPath]}${url.search}`;
    res.writeHead(301, { Location: target, 'Cache-Control': 'public, max-age=3600' });
    res.end();
    return;
  }

  if (await routePortalApi({
    req,
    res,
    url,
    getClientIp,
    consumeRateLimit,
    rateLimitRules: RATE_LIMIT_RULES,
    validateCsrfToken,
    handlers: {
      handlePortalMe,
      handlePortalCaseDocumentDownload,
      handlePortalRequestCode,
      handlePortalVerifyCode,
      handlePortalLogout,
      handlePortalCaseMessage,
    },
  })) return;

  if (await routeLeadEndpoints({
    req,
    res,
    url,
    getClientIp,
    consumeRateLimit,
    rateLimitRules: RATE_LIMIT_RULES,
    validateCsrfToken,
    handlers: {
      handleSubmitLead,
      handleApiLead,
      handleSubscribe,
    },
  })) return;

  if (await routeCheckoutEndpoints({
    req,
    res,
    url,
    getClientIp,
    consumeRateLimit,
    rateLimitRules: RATE_LIMIT_RULES,
    validateCsrfToken,
    handlers: {
      handleCreateCheckoutSession,
      handleConfirmCheckout,
    },
  })) return;

  if (req.method === 'GET' && INDEXNOW_KEY && url.pathname === `/${INDEXNOW_KEY}.txt`) {
    const clientIp = getClientIp(req);
    const rate = consumeRateLimit(RATE_LIMIT_RULES['/robots.txt'], clientIp);
    if (rate.limited) {
      res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': String(rate.retryAfterSec) });
      res.end('Too many requests');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
    res.end(INDEXNOW_KEY);
    return;
  }

  if (await routeIndexNow({
    req, res, url, getClientIp, consumeRateLimit, rateLimitRules: RATE_LIMIT_RULES,
    safeEqual, indexNowReindexToken: INDEXNOW_REINDEX_TOKEN,
    validateAndAttachJsonBody, submitIndexNow,
  })) return;

  if (req.method === 'GET' && handleLegalPage(req, res, normalizedPath, nonce)) return;
  if (routeStaticMeta({
    req,
    res,
    url,
    getClientIp,
    consumeRateLimit,
    rateLimitRules: RATE_LIMIT_RULES,
    siteUrl: SITE_URL,
    primaryHost: PRIMARY_HOST,
    sendCompressed,
    buildSitemapXml,
  })) return;
  if (req.method === 'GET' && (normalizedPath === '/blog/' || normalizedPath in PILLAR_PAGES)) {
    const clientIp = getClientIp(req);
    const rate = consumeRateLimit(RATE_LIMIT_RULES['/dynamic-pages'], clientIp);
    if (rate.limited) {
      res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': String(rate.retryAfterSec) });
      res.end('Demasiadas solicitudes');
      return;
    }
    // Prefer static HTML file if it exists; fall back to generated placeholder
    const staticCandidate = path.join(STATIC_DIR, normalizedPath, 'index.html');
    const htmlHeaders = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' };
    try {
      const data = await fs.promises.readFile(staticCandidate, 'utf8');
      sendCompressed(req, res, htmlHeaders, Buffer.from(injectRuntimeSnippets(data, csrfToken, nonce)));
      return;
    } catch {
      // No static file found; use generated fallback below.
    }
    const html = normalizedPath === '/blog/' ? renderBlogIndex(nonce) : renderPillarPage(normalizedPath, nonce);
    sendCompressed(req, res, htmlHeaders, Buffer.from(html));
    return;
  }
  if (await routeAdmin({
    req,
    res,
    url,
    nonce,
    getClientIp,
    isAdminIpAllowed,
    logAdminAudit,
    consumeRateLimit,
    rateLimitRules: RATE_LIMIT_RULES,
    isAdminAuthorized,
    adminUser: ADMIN_USER,
    adminPassword: ADMIN_PASSWORD,
    safeEqual,
    sendAdminAuthChallenge,
    handlers: {
      handleAdmin,
      handleAdminPortalTestCode,
    },
  })) {
    return;
  }

  if (await routeStaticFiles({
    req,
    res,
    url,
    fs,
    staticDir: STATIC_DIR,
    blockedPrefixes: BLOCKED_PREFIXES,
    blockedFilenames: BLOCKED_FILENAMES,
    mime: MIME,
    compressibleExts: COMPRESSIBLE_EXTS,
    send404,
    injectRuntimeSnippets,
    sendCompressed,
    csrfToken,
    nonce,
  })) return;
  } catch (err) {
    console.error(`[server] unhandled error ${req.method} ${req.url}: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Error interno del servidor' }));
    }
  }
});

setInterval(sweepAllMaps, 30 * 60 * 1000).unref();

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Landing page: http://127.0.0.1:${PORT}`);
  console.log(`Lead submit:  POST http://127.0.0.1:${PORT}/submit-lead`);
  console.log(`Admin panel:  GET  http://127.0.0.1:${PORT}/admin (Basic Auth configured)`);
  console.log(`Admin allowlist: ${ADMIN_ALLOWED_IPS.join(', ') || '(empty - deny all)'}`);
  console.log(`GA4:          ${GA4_MEASUREMENT_ID || '(disabled)'}`);
  if (!ADMIN_PASSWORD) console.warn('WARN: ADMIN_PASSWORD is not set; /admin will return 503');
  console.log(`Paperclip:    ${PAPERCLIP_API}`);
  console.log(`OCR server:   ${OCR_SERVER}`);
  try {
    const ocrHost = new URL(OCR_SERVER).hostname;
    const isInternal = ocrHost === 'localhost' || ocrHost === '127.0.0.1' || /^10\./.test(ocrHost) || /^192\.168\./.test(ocrHost) || /^172\.(1[6-9]|2\d|3[01])\./.test(ocrHost);
    if (!isInternal) console.warn(`WARN: OCR_SERVER_URL (${OCR_SERVER}) is not a private/loopback address — uploaded documents will be forwarded to an external host`);
  } catch { console.warn(`WARN: OCR_SERVER_URL (${OCR_SERVER}) is not a valid URL`); }
});
