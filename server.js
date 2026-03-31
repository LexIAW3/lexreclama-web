/**
 * Landing page server for the despacho.
 * Serves static files and proxies lead form submissions to Paperclip.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const { generateNonce, safeEqual } = require('./utils/crypto');
const { escapeHtml } = require('./utils/html');
const { createFetchWithTimeout, sendCompressed } = require('./utils/http');
const { getClientIp, buildAdminIpChecker } = require('./utils/ip');
const { createSitemapBuilder } = require('./utils/sitemap');
const { sendAdminAuthChallenge, isAdminAuthorized } = require('./utils/auth');
const {
  appendSetCookieHeader,
  buildPortalSessionCookie,
  parsePortalSessionToken,
  getPortalSessionFromRequest,
} = require('./utils/portalAuth');
const {
  normalizeCaseIdentifier,
  isCaseIdentifierValid,
  maskEmail,
  mapIssueToPortalCase,
} = require('./utils/portalCase');
const { sweepPortalState } = require('./utils/portalSessionStore');
const { routePortalApi } = require('./routes/portal');
const { routeAdmin } = require('./routes/admin');
const { routeLeadEndpoints } = require('./routes/leads');
const { routeCheckoutEndpoints } = require('./routes/checkout');
const { routeStaticMeta } = require('./routes/static');
const { routeStaticFiles } = require('./routes/static-files');
const { renderAdminPageTemplate } = require('./templates/admin');
const { renderBlogIndexTemplate } = require('./templates/blog');
const { renderLegalPageTemplate } = require('./templates/legal');
const { renderPillarPageTemplate } = require('./templates/pillar');
const { parseCookies, createCsrfManager } = require('./middleware/csrf');
const { createRateLimiter } = require('./middleware/rateLimit');
const { applySecurityHeaders } = require('./middleware/securityHeaders');
const {
  createNotificationService,
  isValidEmailAddress,
  normalizePhoneForWhatsApp,
  extractClientEmail,
} = require('./services/notifications');
const { createStripeService } = require('./services/stripe');
const { createPaperclipService } = require('./services/paperclip');
const { createRenderer } = require('./services/renderer');
const { createPortalHandlers } = require('./handlers/portal');
const { createLeadHandlers } = require('./handlers/leads');
const { createCheckoutHandlers } = require('./handlers/checkout');
const { createAdminHandlers } = require('./handlers/admin');
const { validateAndAttachJsonBody, parseMultipartOrJsonBody } = require('./utils/bodyParser');
const { detectTestLeadReason } = require('./utils/leads');
const { createIdempotencyManager } = require('./utils/idempotency');
const { createIndexNowService } = require('./services/indexnow');
const { createBlogUtils, formatSlug } = require('./utils/blog');

const PORT = Number(process.env.PORT) || 8080;
const STATIC_DIR = __dirname;
const BLOG_DIR = path.join(__dirname, 'blog');
const LEGAL_TEXTS_PATH = path.join(__dirname, 'legal-texts.md');
const PAPERCLIP_API = process.env.PAPERCLIP_API_URL || 'http://127.0.0.1:3100';
const OCR_SERVER = process.env.OCR_SERVER_URL || 'http://127.0.0.1:3200';
const OCR_SHARED_SECRET = String(process.env.OCR_SHARED_SECRET || '').trim();
const DOCUMENTS_DIR = path.join(__dirname, '..', 'documents');
const SITE_URL = 'https://www.lexreclama.es';
const SUBMIT_API_KEY = process.env.PAPERCLIP_SUBMIT_KEY;
const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID;
const STRIPE_SECRET_KEY = (process.env.STRIPE_SECRET_KEY || '').trim();
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_ALLOWED_IPS = String(process.env.ADMIN_ALLOWED_IPS || '127.0.0.1,::1')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);
const isAdminIpAllowed = buildAdminIpChecker(ADMIN_ALLOWED_IPS);
const GA4_MEASUREMENT_ID = (process.env.GA4_MEASUREMENT_ID || '').trim();
const GOOGLE_ADS_ID = (process.env.GOOGLE_ADS_ID || '').trim();
const GOOGLE_ADS_CONVERSION_LABEL = (process.env.GOOGLE_ADS_CONVERSION_LABEL || '').trim();
const WHATSAPP_NUMBER = (process.env.WHATSAPP_NUMBER || '').trim();
const WHATSAPP_BUSINESS_TOKEN = (process.env.WHATSAPP_BUSINESS_TOKEN || '').trim();
const WHATSAPP_PHONE_NUMBER_ID = (process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim();
const WHATSAPP_TEMPLATE_NAME = (process.env.WHATSAPP_TEMPLATE_NAME || 'lexreclama_bienvenida').trim();
const WHATSAPP_TEMPLATE_LANG = (process.env.WHATSAPP_TEMPLATE_LANG || 'es').trim();
const INDEXNOW_KEY = (process.env.INDEXNOW_KEY || '').trim();
const INDEXNOW_ENDPOINT = (process.env.INDEXNOW_ENDPOINT || 'https://api.indexnow.org/indexnow').trim();
const INDEXNOW_REINDEX_TOKEN = (process.env.INDEXNOW_REINDEX_TOKEN || '').trim();
const BREVO_API_KEY = (process.env.BREVO_API_KEY || '').trim();
const BREVO_LIST_ID = Number.parseInt(process.env.BREVO_LIST_ID || '3', 10);
const BREVO_LEAD_MAGNET_TEMPLATE_ID = Number.parseInt(process.env.BREVO_LEAD_MAGNET_TEMPLATE_ID || '', 10);
const BREVO_API_BASE = 'https://api.brevo.com/v3';
const LEAD_MAGNET_PDF_PATH = '/assets/downloads/lex-guia-reclamar-banco.pdf';
const LEAD_MAGNET_DOWNLOAD_URL = (process.env.LEAD_MAGNET_DOWNLOAD_URL || `${SITE_URL}${LEAD_MAGNET_PDF_PATH}`).trim();
const GESTOR_AGENT_ID = (process.env.PAPERCLIP_GESTOR_AGENT_ID || '').trim();
const GOAL_ID = (process.env.PAPERCLIP_GOAL_ID || '').trim();
const PRIVACY_POLICY_VERSION = '2026-03';
const PRIMARY_HOST = 'lexreclama.es';
const SECONDARY_HOST = 'lexreclama.com';
const APP_HOST = process.env.APP_HOST || 'app.lexreclama.es';
const MAX_RECENT_LEADS = 25;

const recentLeads = [];

// Asset content hashes for cache-busting — computed once at startup.
// HTML pages reference /styles.min.css?v=HASH and /app.min.js?v=HASH so browsers
// re-fetch on deploy while still caching aggressively (max-age=1y, immutable).
function computeFileHash(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 8);
  } catch {
    return 'dev';
  }
}
// Each entry: [attr, url-path, fs-path]  — single source of truth for all assets.
const ASSET_VERSIONS = [
  ['href', '/styles.min.css',            path.join(__dirname, 'styles.min.css')],
  ['src',  '/app.min.js',                path.join(__dirname, 'app.min.js')],
  ['href', '/portal-cliente/styles.min.css', path.join(__dirname, 'portal-cliente', 'styles.min.css')],
  ['src',  '/portal-cliente/app.min.js',     path.join(__dirname, 'portal-cliente', 'app.min.js')],
].map(([attr, url, file]) => ({ attr, url, hash: computeFileHash(file) }));
// Named shorthand used in renderContentShell template literal.
const ASSET_CSS_HASH = ASSET_VERSIONS[0].hash;
const STRIPE_API = 'https://api.stripe.com/v1';

// Fetch timeouts — prevents external API hangs from exhausting the event loop.
// AbortSignal.timeout() is available in Node.js 17.3+ (running on v22).
const FETCH_TIMEOUT_API_MS   = 10 * 1000; // internal Paperclip API
const FETCH_TIMEOUT_EXT_MS   =  8 * 1000; // external APIs (Brevo, Stripe, WhatsApp)
const FETCH_TIMEOUT_OCR_MS   = 30 * 1000; // OCR upload — file transfer + processing
const fetchWithTimeout = createFetchWithTimeout(FETCH_TIMEOUT_EXT_MS);
const PENDING_CHECKOUT_TTL_MS = 6 * 60 * 60 * 1000;
const COMPLETED_CHECKOUT_TTL_MS = 24 * 60 * 60 * 1000;
const pendingCheckoutLeads = new Map();
const completedCheckoutLeads = new Map();
const recentLeadSubmissions = new Map();
const recentCheckoutCreations = new Map();
const PORTAL_CODE_TTL_MS = 10 * 60 * 1000;
const PORTAL_SESSION_TTL_MS = 4 * 60 * 60 * 1000;
const PORTAL_SESSION_COOKIE_NAME = 'lex_portal_session';
const PORTAL_COOKIE_SECURE =
  process.env.NODE_ENV === 'production'
  || String(process.env.HTTPS_ENABLED || '').trim().toLowerCase() === 'true';
const portalAuthCodes = new Map();
const portalSessions = new Map();
const portalMessages = new Map();
const runPortalStateSweep = () => sweepPortalState({ portalAuthCodes, portalSessions });
const parsePortalSessionTokenFromRequest = (req) => parsePortalSessionToken(req, {
  cookieName: PORTAL_SESSION_COOKIE_NAME,
  parseCookies,
});
const buildPortalSessionCookieHeader = (token, maxAgeSeconds) => buildPortalSessionCookie(token, maxAgeSeconds, {
  cookieName: PORTAL_SESSION_COOKIE_NAME,
  secure: PORTAL_COOKIE_SECURE,
});
const getPortalSession = (req) => getPortalSessionFromRequest(req, {
  portalSessions,
  sweepPortalState: runPortalStateSweep,
  parsePortalSessionTokenFromRequest,
});
const BLOG_REDIRECTS = {
  '/blog/cuanto-cuesta-monitorio/': '/blog/coste-monitorio/',
  '/blog/gastos-hipotecarios/': '/blog/reclamar-gastos-hipoteca/',
};

const {
  subscribeContactInBrevo,
  sendLeadMagnetEmail,
  sendPortalCodeEmail,
  sendLeadConfirmationEmail,
  sendWhatsAppWelcome,
} = createNotificationService({
  brevoApiKey: BREVO_API_KEY,
  brevoListId: BREVO_LIST_ID,
  brevoLeadMagnetTemplateId: BREVO_LEAD_MAGNET_TEMPLATE_ID,
  brevoApiBase: BREVO_API_BASE,
  leadMagnetDownloadUrl: LEAD_MAGNET_DOWNLOAD_URL,
  whatsappBusinessToken: WHATSAPP_BUSINESS_TOKEN,
  whatsappPhoneNumberId: WHATSAPP_PHONE_NUMBER_ID,
  whatsappTemplateName: WHATSAPP_TEMPLATE_NAME,
  whatsappTemplateLang: WHATSAPP_TEMPLATE_LANG,
  fetchWithTimeout,
  escapeHtml,
  detectTestLeadReason,
});

const {
  uploadDocumentToOcr,
  createIssueForLead,
  fetchIssueByIdentifier,
  fetchIssueComments,
} = createPaperclipService({
  paperclipApi: PAPERCLIP_API,
  companyId: COMPANY_ID,
  submitApiKey: SUBMIT_API_KEY,
  fetchWithTimeout,
  fetchTimeoutApiMs: FETCH_TIMEOUT_API_MS,
  fetchTimeoutOcrMs: FETCH_TIMEOUT_OCR_MS,
  gestorAgentId: GESTOR_AGENT_ID,
  goalId: GOAL_ID,
  ocrServer: OCR_SERVER,
  ocrSharedSecret: OCR_SHARED_SECRET,
  sendLeadConfirmationEmail,
  sendWhatsAppWelcome,
  maskEmail,
  recentLeads,
  maxRecentLeads: MAX_RECENT_LEADS,
});

const {
  handleAdminPortalTestCode,
  handlePortalRequestCode,
  handlePortalVerifyCode,
  handlePortalMe,
  handlePortalLogout,
  handlePortalCaseMessage,
  handlePortalCaseDocumentDownload,
} = createPortalHandlers({
  portalAuthCodes,
  portalSessions,
  portalMessages,
  runPortalStateSweep,
  parsePortalSessionTokenFromRequest,
  buildPortalSessionCookieHeader,
  getPortalSession,
  PORTAL_CODE_TTL_MS,
  PORTAL_SESSION_TTL_MS,
  DOCUMENTS_DIR,
  SUBMIT_API_KEY,
  PAPERCLIP_API,
  FETCH_TIMEOUT_API_MS,
  fetchIssueByIdentifier,
  fetchIssueComments,
  sendPortalCodeEmail,
  fetchWithTimeout,
  extractClientEmail,
  appendSetCookieHeader,
  normalizeCaseIdentifier,
  isCaseIdentifierValid,
  maskEmail,
  mapIssueToPortalCase,
});

/* ─── RATE LIMITER + CSRF ────────────────────────────────────── */
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_RULES = {
  '/health': { scope: 'health', max: 60, windowMs: 60 * 1000 },
  '/submit-lead': { scope: 'submit-lead', max: 5 },
  '/api/lead': { scope: 'api-lead', max: 8 },
  '/api/leads': { scope: 'api-lead', max: 8 },
  '/admin': { scope: 'admin-login', max: 10 },
  '/api/admin/portal-test-code': { scope: 'admin-portal-test-code', max: 20 },
  '/create-checkout-session': { scope: 'create-checkout-session', max: 3 },
  '/confirm-checkout': { scope: 'confirm-checkout', max: 10 },
  '/api/subscribe': { scope: 'api-subscribe', max: 12 },
  '/api/portal/request-code': { scope: 'portal-request-code', max: 6 },
  '/api/portal/verify-code': { scope: 'portal-verify-code', max: 20 },
  '/api/portal/logout': { scope: 'portal-logout', max: 30 },
  '/api/portal/cases': { scope: 'portal-cases', max: 60 },
  '/api/portal/documents': { scope: 'portal-documents', max: 80 },
  '/api/portal/me': { scope: 'portal-me', max: 120 },
  '/robots.txt': { scope: 'robots-txt', max: 300 },
  '/sitemap.xml': { scope: 'sitemap-xml', max: 240 },
  '/dynamic-pages': { scope: 'dynamic-pages', max: 180 },
};

const CSRF_COOKIE_NAME = 'lex_csrf_token';
const CSRF_TTL_MS = 12 * 60 * 60 * 1000;
const {
  sweepCsrfTokens,
  getOrCreateCsrfToken,
  validateCsrfToken,
} = createCsrfManager({
  cookieName: CSRF_COOKIE_NAME,
  ttlMs: CSRF_TTL_MS,
  randomToken: () => crypto.randomBytes(32).toString('hex'),
  safeEqual,
  parseBody: parseMultipartOrJsonBody,
});


const {
  consumeRateLimit,
  sweepRateLimitEntries,
} = createRateLimiter({ defaultWindowMs: RATE_LIMIT_WINDOW_MS });

const {
  sweepIdempotencyMaps,
  resolveIdempotentRequest,
} = createIdempotencyManager({
  maps: [recentLeadSubmissions, recentCheckoutCreations],
  windowMs: 60 * 1000,
});

const PAID_CLAIM_TYPES = {
  deuda: {
    label: 'Reclamación de deuda impagada',
    grossAmountCents: 5929, // 49 EUR + 21% IVA
    baseAmountLabel: '49 EUR + IVA',
  },
  multa: {
    label: 'Impugnación de multa',
    grossAmountCents: 4719, // 39 EUR + 21% IVA
    baseAmountLabel: '39 EUR + IVA',
  },
};

const {
  requiresUpfrontPayment,
  normalizeLeadPayload,
  handleSubmitLead,
  handleApiLead,
  handleSubscribe,
} = createLeadHandlers({
  createIssueForLead,
  uploadDocumentToOcr,
  resolveIdempotentRequest,
  recentLeadSubmissions,
  subscribeContactInBrevo,
  sendLeadMagnetEmail,
  maskEmail,
  detectTestLeadReason,
  paidClaimTypes: PAID_CLAIM_TYPES,
  leadMagnetPdfPath: LEAD_MAGNET_PDF_PATH,
  privacyPolicyVersion: PRIVACY_POLICY_VERSION,
});

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.txt':  'text/plain; charset=utf-8',
  '.xml':  'application/xml; charset=utf-8',
  '.ico':  'image/x-icon',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.webp': 'image/webp',
  '.pdf':  'application/pdf',
};

const PILLAR_PAGES = {
  '/reclamacion-deudas/': {
    title: 'Reclamacion de deudas',
    subtitle: 'Pilar: procedimiento monitorio',
    placeholder: 'Contenido en preparacion. Aqui se publicara la guia completa sobre reclamacion de deudas y procedimiento monitorio.',
  },
  '/clausulas-bancarias/': {
    title: 'Clausulas bancarias abusivas',
    subtitle: 'Pilar: clausulas bancarias',
    placeholder: 'Contenido en preparacion. Aqui se publicara la pagina pilar sobre clausulas bancarias abusivas.',
  },
  '/clausulas-bancarias/gastos-hipotecarios/': {
    title: 'Gastos hipotecarios',
    subtitle: 'Subpagina de clausulas bancarias',
    placeholder: 'Contenido en preparacion. Aqui se publicara la guia de reclamacion de gastos hipotecarios.',
  },
  '/clausulas-bancarias/clausula-suelo/': {
    title: 'Clausula suelo',
    subtitle: 'Subpagina de clausulas bancarias',
    placeholder: 'Contenido en preparacion. Aqui se publicara la guia para reclamar clausula suelo.',
  },
  '/clausulas-bancarias/irph-hipoteca/': {
    title: 'IRPH hipoteca',
    subtitle: 'Subpagina de clausulas bancarias',
    placeholder: 'Contenido en preparacion. Aqui se publicara la guia para reclamar el IRPH hipotecario.',
  },
  '/recurrir-multas/': {
    title: 'Recurrir multas y sanciones',
    subtitle: 'Pilar: multas y sanciones',
    placeholder: 'Contenido en preparacion. Aqui se publicara la guia para recurrir multas DGT y sanciones administrativas.',
  },
};

function normalizePathname(pathname) {
  if (!pathname || pathname === '/') return '/';
  return pathname.endsWith('/') ? pathname : `${pathname}/`;
}

const { listBlogArticles } = createBlogUtils({ fs, path, blogDir: BLOG_DIR });

const buildSitemapXml = createSitemapBuilder({
  siteUrl: SITE_URL,
  staticDir: STATIC_DIR,
  listBlogArticles,
  blogRedirects: BLOG_REDIRECTS,
  fsModule: fs,
  pathModule: path,
});

const PAGE_404_PATH = path.join(STATIC_DIR, '404.html');

const {
  injectRuntimeSnippets,
  renderBlogIndex,
  renderPillarPage,
  handleLegalPage,
  renderAdminPage,
  send404,
} = createRenderer({
  siteUrl: SITE_URL,
  assetCssHash: ASSET_CSS_HASH,
  assetVersions: ASSET_VERSIONS,
  ga4MeasurementId: GA4_MEASUREMENT_ID,
  googleAdsId: GOOGLE_ADS_ID,
  googleAdsConversionLabel: GOOGLE_ADS_CONVERSION_LABEL,
  whatsappNumber: WHATSAPP_NUMBER,
  maxRecentLeads: MAX_RECENT_LEADS,
  legalTextsPath: LEGAL_TEXTS_PATH,
  page404Path: PAGE_404_PATH,
  pillarPages: PILLAR_PAGES,
  recentLeads,
  escapeHtml,
  sendCompressed,
  fs,
  renderBlogIndexTemplate,
  renderPillarPageTemplate,
  renderAdminPageTemplate,
  renderLegalPageTemplate,
  listBlogArticles,
  formatSlug,
});

const {
  normalizeIndexNowUrl,
  submitIndexNow,
} = createIndexNowService({
  indexNowKey: INDEXNOW_KEY,
  siteUrl: SITE_URL,
  indexNowEndpoint: INDEXNOW_ENDPOINT,
  fetchWithTimeout,
});

const COMPRESSIBLE_EXTS = new Set(['.html', '.css', '.js', '.json', '.xml', '.txt', '.svg']);

const {
  handleAdmin,
  logAdminAudit,
} = createAdminHandlers({
  getClientIp,
  adminPassword: ADMIN_PASSWORD,
  adminUser: ADMIN_USER,
  isAdminAuthorized,
  safeEqual,
  sendAdminAuthChallenge,
  renderAdminPage,
});

function getBaseUrl(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const host = String(req.headers.host || '').trim();
  const defaultProtocol = host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https';
  const protocol = forwardedProto || defaultProtocol;
  if (!host) return SITE_URL;
  return `${protocol}://${host}`;
}

const {
  createStripeCheckoutSession,
  readStripeCheckoutSession,
  sweepPendingCheckoutLeads,
} = createStripeService({
  stripeSecretKey: STRIPE_SECRET_KEY,
  stripeApi: STRIPE_API,
  fetchWithTimeout,
  paidClaimTypes: PAID_CLAIM_TYPES,
  getBaseUrl,
  pendingCheckoutLeads,
  completedCheckoutLeads,
  pendingCheckoutTtlMs: PENDING_CHECKOUT_TTL_MS,
  completedCheckoutTtlMs: COMPLETED_CHECKOUT_TTL_MS,
});

const {
  handleCreateCheckoutSession,
  handleConfirmCheckout,
} = createCheckoutHandlers({
  normalizeLeadPayload,
  requiresUpfrontPayment,
  resolveIdempotentRequest,
  recentCheckoutCreations,
  pendingCheckoutLeads,
  completedCheckoutLeads,
  createStripeCheckoutSession,
  readStripeCheckoutSession,
  sweepPendingCheckoutLeads,
  createIssueForLead,
  paidClaimTypes: PAID_CLAIM_TYPES,
});

const BLOCKED_PREFIXES = ['/social-templates/', '/social-templates', '/utils/', '/utils', '/middleware/', '/middleware', '/routes/', '/routes', '/services/', '/services', '/templates/', '/templates', '/handlers/', '/handlers', '/node_modules/', '/node_modules'];
const BLOCKED_FILENAMES = new Set(['server.js', 'package.json', 'package-lock.json', 'start.sh', 'ensure-running.sh', 'legal-texts.md', 'logo-preview.html', 'design-system.html']);

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

  if (req.method === 'POST' && url.pathname === '/api/indexnow/reindex') {
    if (!INDEXNOW_REINDEX_TOKEN) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'INDEXNOW_REINDEX_TOKEN no configurado' }));
      return;
    }
    const token = String(req.headers['x-indexnow-token'] || '').trim();
    if (!token || !safeEqual(token, INDEXNOW_REINDEX_TOKEN)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No autorizado' }));
      return;
    }
    const clientIp = getClientIp(req);
    const rate = consumeRateLimit(RATE_LIMIT_RULES['/api/lead'], clientIp);
    if (rate.limited) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(rate.retryAfterSec) });
      res.end(JSON.stringify({ error: 'Demasiadas solicitudes' }));
      return;
    }
    if (!(await validateAndAttachJsonBody(req, res))) return;
    const body = req.parsedBody || {};
    const urls = Array.isArray(body.urls) ? body.urls : [];
    if (!urls.length) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Debes enviar un array `urls`' }));
      return;
    }
    const result = await submitIndexNow(urls);
    res.writeHead(result.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

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

// Periodic sweep of all in-memory Maps to prevent unbounded growth.
// Belt-and-suspenders: individual handlers also call sweep at their entry points.
function sweepAllMaps() {
  runPortalStateSweep(); // clears expired portalAuthCodes + portalSessions
  sweepCsrfTokens();

  // portalMessages: remove entries whose caseId has no active session.
  // Messages are a display cache — canonical data lives in the API.
  const activeCaseIds = new Set([...portalSessions.values()].map((s) => s.caseId));
  for (const caseId of portalMessages.keys()) {
    if (!activeCaseIds.has(caseId)) portalMessages.delete(caseId);
  }

  // rate limit entries: delete fully-expired keys to prevent unbounded growth.
  sweepRateLimitEntries();
}

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
