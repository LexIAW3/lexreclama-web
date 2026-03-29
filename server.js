/**
 * Landing page server for the despacho.
 * Serves static files and proxies lead form submissions to Paperclip.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { URL } = require('url');
const busboy = require('busboy');
const { generateNonce, safeEqual } = require('./utils/crypto');
const { escapeHtml } = require('./utils/html');
const { getClientIp, buildAdminIpChecker } = require('./utils/ip');
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
const { routeSubscribeEndpoint } = require('./routes/subscribe');
const { routeStaticMeta } = require('./routes/static');
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

// Test lead blocklist — submissions from these emails are accepted (HTTP 200) but
// not forwarded to Paperclip so they don't generate noise for the claims manager.
const TEST_EMAIL_BLOCKLIST = new Set([
  't@t.com',
  'test@test.com',
  'qa@qa.com',
  'qa@test.com',
  'test@qa.com',
]);
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
function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_EXT_MS) {
  return fetch(url, { signal: AbortSignal.timeout(timeoutMs), ...options });
}
const PENDING_CHECKOUT_TTL_MS = 6 * 60 * 60 * 1000;
const COMPLETED_CHECKOUT_TTL_MS = 24 * 60 * 60 * 1000;
const IDEMPOTENCY_WINDOW_MS = 60 * 1000;
const pendingCheckoutLeads = new Map();
const completedCheckoutLeads = new Map();
const recentLeadSubmissions = new Map();
const recentCheckoutCreations = new Map();
const idempotencyInFlight = new Map();
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

function detectTestLeadReason(leadData) {
  const email = String(leadData?.email || '').trim().toLowerCase();
  const nombre = String(leadData?.nombre || '').trim().toLowerCase();
  if (!email) return '';

  if (TEST_EMAIL_BLOCKLIST.has(email)) return 'email_blocklist';

  const parts = email.split('@');
  const local = parts[0] || '';
  const domain = parts[1] || '';

  if (domain.endsWith('.invalid')) return 'invalid_tld';
  if (domain === 'lexreclama-test.invalid') return 'qa_domain';
  if (local.startsWith('qa-smoke')) return 'qa_smoke_local';
  if (local === 'qa' || local === 'smoke') return 'qa_local';
  if (nombre.includes('qa test') || nombre.includes('smoke test')) return 'qa_name';

  return '';
}

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

/* ─── RATE LIMITER + CSRF ────────────────────────────────────── */
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_RULES = {
  '/health': { scope: 'health', max: 60, windowMs: 60 * 1000 },
  '/submit-lead': { scope: 'submit-lead', max: 5 },
  '/api/lead': { scope: 'api-lead', max: 8 },
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

function validateAndAttachJsonBody(req, res) {
  return (async () => {
    if (Object.prototype.hasOwnProperty.call(req, 'parsedBody')) return true;
    let parsed;
    try {
      parsed = JSON.parse(await readBody(req));
    } catch (err) {
      const status = err.statusCode || 400;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: status === 413 ? 'Payload too large' : 'Invalid JSON' }));
      return false;
    }
    req.parsedBody = parsed;
    return true;
  })();
}

const MAX_UPLOAD_FILE_BYTES = 10 * 1024 * 1024; // 10 MB per file
const MAX_UPLOAD_FILES = 3;
const ALLOWED_UPLOAD_MIMETYPES = new Set(['application/pdf', 'image/jpeg', 'image/png']);

function parseMultipartOrJsonBody(req, res) {
  return new Promise((resolve) => {
    if (Object.prototype.hasOwnProperty.call(req, 'parsedBody')) { resolve(true); return; }
    const contentType = String(req.headers['content-type'] || '');
    if (!contentType.startsWith('multipart/form-data')) {
      validateAndAttachJsonBody(req, res).then(resolve);
      return;
    }
    const fields = {};
    const files = [];
    let rejected = false;
    let bb;
    try {
      bb = busboy({ headers: req.headers, limits: { fileSize: MAX_UPLOAD_FILE_BYTES, files: MAX_UPLOAD_FILES + 1, fieldSize: 8 * 1024 } });
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Formulario inválido' }));
      resolve(false);
      return;
    }
    bb.on('field', (name, val) => { fields[name] = val; });
    bb.on('file', (name, stream, info) => {
      const { filename, mimeType } = info;
      if (!ALLOWED_UPLOAD_MIMETYPES.has(mimeType)) {
        stream.resume();
        return;
      }
      const chunks = [];
      let size = 0;
      stream.on('data', (d) => { size += d.length; chunks.push(d); });
      stream.on('close', () => {
        if (stream.truncated) return; // exceeded fileSize limit — skip
        if (files.length < MAX_UPLOAD_FILES) {
          const safeName = (filename || 'upload').replace(/[\r\n"\\]/g, '_').slice(0, 255);
          files.push({ originalname: safeName, mimetype: mimeType, buffer: Buffer.concat(chunks), size });
        }
      });
    });
    bb.on('close', () => {
      if (rejected) return;
      req.parsedBody = {
        ...fields,
        privacidadAceptada: fields.privacidadAceptada === 'true',
        comercialAceptada: fields.comercialAceptada === 'true',
      };
      req.uploadedFiles = files;
      resolve(true);
    });
    bb.on('error', () => {
      if (rejected) return;
      rejected = true;
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Error procesando el formulario' }));
      resolve(false);
    });
    req.pipe(bb);
  });
}

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

const {
  consumeRateLimit,
  sweepRateLimitEntries,
} = createRateLimiter({ defaultWindowMs: RATE_LIMIT_WINDOW_MS });

function sweepIdempotencyMaps() {
  const now = Date.now();
  for (const [key, entry] of recentLeadSubmissions) {
    if (now - entry.createdAtMs > IDEMPOTENCY_WINDOW_MS) {
      recentLeadSubmissions.delete(key);
    }
  }
  for (const [key, entry] of recentCheckoutCreations) {
    if (now - entry.createdAtMs > IDEMPOTENCY_WINDOW_MS) {
      recentCheckoutCreations.delete(key);
    }
  }
}

async function resolveIdempotentRequest({ scope, key, store, execute }) {
  if (!key) {
    return { value: await execute(), deduplicated: false };
  }

  sweepIdempotencyMaps();
  const cached = store.get(key);
  if (cached) {
    return { value: cached.payload, deduplicated: true };
  }

  const inFlightKey = `${scope}:${key}`;
  if (idempotencyInFlight.has(inFlightKey)) {
    const value = await idempotencyInFlight.get(inFlightKey);
    return { value, deduplicated: true };
  }

  const pending = (async () => {
    const value = await execute();
    store.set(key, { createdAtMs: Date.now(), payload: value });
    return value;
  })();

  idempotencyInFlight.set(inFlightKey, pending);
  try {
    const value = await pending;
    return { value, deduplicated: false };
  } finally {
    idempotencyInFlight.delete(inFlightKey);
  }
}
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

const BLOG_ARTICLES_CACHE_TTL_MS = 60 * 1000; // 60 s
let blogArticlesCache = null;
let blogArticlesCachedAtMs = 0;

const SITEMAP_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min
let sitemapCache = null;
let sitemapCachedAtMs = 0;

function listBlogArticles() {
  const now = Date.now();
  if (blogArticlesCache && now - blogArticlesCachedAtMs < BLOG_ARTICLES_CACHE_TTL_MS) {
    return blogArticlesCache;
  }
  try {
    const entries = fs.readdirSync(BLOG_DIR, { withFileTypes: true });
    const result = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((slug) => fs.existsSync(path.join(BLOG_DIR, slug, 'index.html')))
      .sort();
    blogArticlesCache = result;
    blogArticlesCachedAtMs = now;
    return result;
  } catch {
    return [];
  }
}

function formatSlug(slug) {
  return slug
    .split('-')
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(' ');
}

function renderContentShell({ pageTitle, metaDescription, heading, intro, bodyHtml, canonicalPath = '/', noindex = false, nonce = '' }) {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="description" content="${escapeHtml(metaDescription)}" />
  <link rel="canonical" href="${SITE_URL}${canonicalPath}" />
  <meta name="robots" content="${noindex ? 'noindex,follow' : 'index,follow'}" />
  <title>${escapeHtml(pageTitle)} | LexReclama</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
  <link rel="icon" href="/favicon.svg" sizes="any" />
  <link rel="apple-touch-icon" href="/logo-avatar.png" />
  <link rel="stylesheet" href="/styles.min.css?v=${ASSET_CSS_HASH}" />
  ${renderGa4Snippet(nonce)}
</head>
<body>
  <nav class="nav" aria-label="Navegación principal">
    <div class="nav-inner">
      <a href="/" class="logo" aria-label="LexReclama — inicio">LexReclama<span>.</span></a>
      <div>
        <a class="btn btn-sm" href="/reclamacion-deudas/"${canonicalPath.startsWith('/reclamacion-deudas/') ? ' aria-current="page"' : ''}>Deudas</a>
        <a class="btn btn-sm" href="/clausulas-bancarias/"${canonicalPath.startsWith('/clausulas-bancarias/') ? ' aria-current="page"' : ''}>Cláusulas</a>
        <a class="btn btn-sm" href="/recurrir-multas/"${canonicalPath.startsWith('/recurrir-multas/') ? ' aria-current="page"' : ''}>Multas</a>
        <a class="btn btn-sm" href="/blog/"${canonicalPath.startsWith('/blog/') ? ' aria-current="page"' : ''}>Blog</a>
      </div>
    </div>
  </nav>
  <main id="content-root" class="container content-shell-main">
    <section>
      <p class="eyebrow">${escapeHtml(intro)}</p>
      <h1 class="content-shell-h1">${escapeHtml(heading)}</h1>
      ${bodyHtml}
    </section>
  </main>
  <footer class="footer">
    <div class="container footer-inner">
      <a href="/" class="logo" aria-label="LexReclama — inicio">LexReclama<span>.</span></a>
      <div class="footer-links">
        <a href="/aviso-legal/">Aviso legal</a>
        <a href="/politica-privacidad/">Política de privacidad</a>
        <a href="/politica-cookies/">Política de cookies</a>
        <a href="/condiciones/">Condiciones generales</a>
      </div>
      <p class="footer-copy">© 2026 LexReclama · <a href="mailto:hola@lexreclama.es">hola@lexreclama.es</a></p>
    </div>
  </footer>
  ${renderWhatsappButtonHtml()}
</body>
</html>`;
}

function renderGa4Snippet(nonce = '') {
  const trackingIds = [GA4_MEASUREMENT_ID, GOOGLE_ADS_ID].filter(Boolean);
  if (!trackingIds.length) return '';

  const bootstrapId = trackingIds[0];
  const configLines = trackingIds.map((id) => `    gtag("config", "${escapeHtml(id)}");`).join('\n');
  const adsSendTo = GOOGLE_ADS_ID && GOOGLE_ADS_CONVERSION_LABEL
    ? `${GOOGLE_ADS_ID}/${GOOGLE_ADS_CONVERSION_LABEL}`
    : '';
  const trackingBlock = adsSendTo
    ? `\n    window.__LEX_TRACKING = Object.assign({}, window.__LEX_TRACKING || {}, {\n      adsConversionSendTo: "${escapeHtml(adsSendTo)}",\n      adsConversionValue: 49.0,\n      adsConversionCurrency: "EUR"\n    });`
    : '';
  const nonceAttr = nonce ? ` nonce="${nonce}"` : '';

  return `<!-- Google tag (gtag.js) -->
  <script async src="https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(bootstrapId)}"></script>
  <script${nonceAttr}>
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    gtag("consent", "default", {
      ad_storage: "denied",
      analytics_storage: "denied",
      wait_for_update: 500
    });
    gtag("js", new Date());
${configLines}${trackingBlock}
  </script>`;
}

function injectGa4IntoHtml(html) {
  if (!GA4_MEASUREMENT_ID && !GOOGLE_ADS_ID) {
    return html.replace('<!-- GA4_SNIPPET -->', '');
  }
  const snippet = renderGa4Snippet();
  if (html.includes('<!-- GA4_SNIPPET -->')) {
    return html.replace('<!-- GA4_SNIPPET -->', snippet);
  }
  return html.replace('</head>', `${snippet}\n</head>`);
}

function normalizeWhatsappNumber(raw) {
  const cleaned = String(raw || '').replace(/[^\d]/g, '');
  return cleaned || '';
}

function buildWhatsappHref() {
  const number = normalizeWhatsappNumber(WHATSAPP_NUMBER);
  if (!number) return null;
  const message = 'Hola, necesito información sobre una reclamación';
  return `https://wa.me/${encodeURIComponent(number)}?text=${encodeURIComponent(message)}`;
}

function renderWhatsappButtonHtml() {
  const href = buildWhatsappHref();
  if (!href) return '';
  return `
  <a
    href="${href}"
    id="whatsapp-float"
    class="whatsapp-float"
    target="_blank"
    rel="noopener noreferrer"
    aria-label="Consulta gratis por WhatsApp"
  >
    <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M19.11 17.18c-.27-.14-1.58-.78-1.82-.87-.25-.09-.43-.14-.62.14-.18.27-.7.87-.86 1.05-.16.18-.31.2-.58.07-.27-.14-1.13-.42-2.15-1.34-.79-.7-1.32-1.56-1.47-1.83-.16-.27-.02-.41.11-.54.12-.12.27-.31.41-.47.14-.16.18-.27.27-.46.09-.18.05-.34-.02-.48-.07-.14-.62-1.49-.85-2.04-.22-.53-.45-.45-.62-.46h-.53c-.18 0-.47.07-.72.34-.25.27-.95.93-.95 2.26s.98 2.61 1.12 2.79c.14.18 1.93 2.95 4.67 4.14.65.28 1.16.45 1.56.58.66.21 1.26.18 1.73.11.53-.08 1.58-.64 1.8-1.26.22-.63.22-1.16.16-1.27-.07-.11-.25-.18-.52-.32zM16.05 4.8c-6.17 0-11.17 5-11.17 11.17 0 1.96.51 3.88 1.48 5.56L4.8 27.2l5.84-1.53a11.15 11.15 0 0 0 5.4 1.39h.01c6.16 0 11.17-5 11.17-11.17S22.22 4.8 16.05 4.8zm0 20.4h-.01a9.2 9.2 0 0 1-4.68-1.28l-.34-.2-3.46.9.92-3.38-.22-.35a9.2 9.2 0 0 1-1.42-4.92c0-5.08 4.13-9.21 9.21-9.21s9.21 4.13 9.21 9.21-4.13 9.21-9.21 9.21z"/>
    </svg>
    <span class="whatsapp-tooltip" role="tooltip">Consulta gratis por WhatsApp</span>
  </a>`;
}

function injectWhatsappIntoHtml(html) {
  const button = renderWhatsappButtonHtml();
  if (html.includes('<!-- WHATSAPP_BUTTON -->')) {
    return html.replace('<!-- WHATSAPP_BUTTON -->', button);
  }
  if (!button) return html;
  return html.replace('</body>', `${button}\n</body>`);
}

function injectNonceIntoHtml(html, nonce) {
  return html
    .replace(/<script([^>]*)>/g, (match, attrs) => {
      if (/\bsrc=/.test(attrs)) return match;
      if (/type="application\/ld\+json"/.test(attrs)) return match;
      return `<script${attrs} nonce="${nonce}">`;
    })
    .replace(/<style([^>]*)>/g, (match, attrs) => {
      if (/\bhref=/.test(attrs)) return match; // external <link rel=stylesheet>
      return `<style${attrs} nonce="${nonce}">`;
    });
}

function injectCsrfIntoHtml(html, token) {
  if (!token || !html.includes('name="csrfToken"')) return html;
  return html.replace(
    /(<input[^>]*name="csrfToken"[^>]*value=")[^"]*(")/g,
    `$1${token}$2`,
  );
}

function injectAssetVersionsIntoHtml(html) {
  let result = html;
  for (const { attr, url, hash } of ASSET_VERSIONS) {
    result = result.replace(
      new RegExp(`${attr}="(${url.replace(/[.]/g, '\\.')})"`, 'g'),
      `${attr}="$1?v=${hash}"`,
    );
  }
  return result;
}

function injectRuntimeSnippets(html, csrfToken = '', nonce = '') {
  let result = injectCsrfIntoHtml(injectWhatsappIntoHtml(injectGa4IntoHtml(injectAssetVersionsIntoHtml(html))), csrfToken);
  if (nonce) result = injectNonceIntoHtml(result, nonce);
  return result;
}

function renderBlogIndex(nonce = '') {
  const articles = listBlogArticles();
  const items = articles.length
    ? `<ul>${articles.map((slug) => `<li><a href="/blog/${slug}/">${escapeHtml(formatSlug(slug))}</a></li>`).join('')}</ul>`
    : '<p>Todavía no hay artículos publicados.</p>';

  return renderContentShell({
    pageTitle: 'Blog legal',
    metaDescription: 'Hub de contenido legal sobre reclamaciones de deudas, cláusulas bancarias y multas.',
    heading: 'Blog de reclamaciones legales',
    intro: 'Hub de contenido',
    bodyHtml: `<p>Artículos disponibles:</p>${items}`,
    canonicalPath: '/blog/',
    nonce,
  });
}

function renderPillarPage(pathname, nonce = '') {
  const page = PILLAR_PAGES[pathname];
  if (!page) return null;
  return renderContentShell({
    pageTitle: page.title,
    metaDescription: page.placeholder,
    heading: page.title,
    intro: page.subtitle,
    bodyHtml: `<p>${escapeHtml(page.placeholder)}</p>`,
    canonicalPath: pathname,
    noindex: true,
    nonce,
  });
}

function buildSitemapXmlUncached() {
  // Legal pages are noindex — excluded from sitemap (crawl budget, Google guidelines)
  const staticUrls = [
    '/',
    '/contacto/',
    '/reclamacion-deudas/',
    '/clausulas-bancarias/',
    '/clausulas-bancarias/gastos-hipotecarios/',
    '/clausulas-bancarias/clausula-suelo/',
    '/clausulas-bancarias/irph-hipoteca/',
    '/recurrir-multas/',
    '/multas-dgt/',
    '/blog/',
  ];
  const blogUrls = listBlogArticles()
    .map((slug) => `/blog/${slug}/`)
    .filter((urlPath) => !BLOG_REDIRECTS[urlPath]);
  const urls = [...staticUrls, ...blogUrls];

  function urlLastMod(urlPath) {
    // Map URL path → local HTML file to read mtime
    const filePath = urlPath === '/'
      ? path.join(STATIC_DIR, 'index.html')
      : path.join(STATIC_DIR, urlPath.replace(/^\//, ''), 'index.html');
    try {
      const mtime = fs.statSync(filePath).mtime;
      return mtime.toISOString().slice(0, 10); // YYYY-MM-DD
    } catch {
      return new Date().toISOString().slice(0, 10);
    }
  }

  const body = urls
    .map((urlPath) => `  <url><loc>${SITE_URL}${urlPath}</loc><lastmod>${urlLastMod(urlPath)}</lastmod></url>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

function buildSitemapXml() {
  const now = Date.now();
  if (sitemapCache && now - sitemapCachedAtMs < SITEMAP_CACHE_TTL_MS) {
    return sitemapCache;
  }
  sitemapCache = buildSitemapXmlUncached();
  sitemapCachedAtMs = now;
  return sitemapCache;
}

const MAX_BODY_BYTES = 50 * 1024; // 50 KB

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    req.on('data', (c) => {
      received += c.length;
      if (received > MAX_BODY_BYTES) {
        req.destroy();
        reject(Object.assign(new Error('Payload too large'), { statusCode: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function readLegalTexts() {
  try {
    return fs.readFileSync(LEGAL_TEXTS_PATH, 'utf8');
  } catch (err) {
    console.warn(`WARN: could not read legal texts file at ${LEGAL_TEXTS_PATH}: ${err.message}`);
    return '';
  }
}

function sectionSlice(fullText, startMarker, endMarker) {
  const start = fullText.indexOf(startMarker);
  if (start === -1) return '';
  const end = endMarker ? fullText.indexOf(endMarker, start + startMarker.length) : -1;
  const out = end === -1 ? fullText.slice(start) : fullText.slice(start, end);
  return out.replaceAll('\\[', '[').replaceAll('\\]', ']').trim();
}

const LEGAL_TEXTS = readLegalTexts();
const LEGAL_PAGES = {
  '/aviso-legal/': {
    title: 'Aviso Legal',
    body: sectionSlice(LEGAL_TEXTS, '# 1. AVISO LEGAL', '# 2. POLÍTICA DE PRIVACIDAD'),
  },
  '/politica-privacidad/': {
    title: 'Política de Privacidad',
    body: sectionSlice(LEGAL_TEXTS, '# 2. POLÍTICA DE PRIVACIDAD', '# 3. POLÍTICA DE COOKIES'),
  },
  '/politica-cookies/': {
    title: 'Política de Cookies',
    body: sectionSlice(LEGAL_TEXTS, '# 3. POLÍTICA DE COOKIES', '# 4. CONDICIONES GENERALES DE CONTRATACIÓN'),
  },
  '/condiciones/': {
    title: 'Condiciones Generales de Contratación',
    body: sectionSlice(LEGAL_TEXTS, '# 4. CONDICIONES GENERALES DE CONTRATACIÓN', '# 5. TEXTOS DE CONSENTIMIENTO — FORMULARIO DE CONTACTO / INTAKE'),
  },
};

const COMPRESSIBLE_EXTS = new Set(['.html', '.css', '.js', '.json', '.xml', '.txt', '.svg']);

function sendCompressed(req, res, headers, body, statusCode = 200) {
  const accept = String(req.headers['accept-encoding'] || '');
  if (accept.includes('br') && typeof zlib.brotliCompress === 'function') {
    zlib.brotliCompress(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } }, (err, compressed) => {
      if (err) { res.writeHead(statusCode, headers); res.end(body); return; }
      res.writeHead(statusCode, { ...headers, 'Content-Encoding': 'br', 'Vary': 'Accept-Encoding' });
      res.end(compressed);
    });
  } else if (accept.includes('gzip')) {
    zlib.gzip(body, { level: 6 }, (err, compressed) => {
      if (err) { res.writeHead(statusCode, headers); res.end(body); return; }
      res.writeHead(statusCode, { ...headers, 'Content-Encoding': 'gzip', 'Vary': 'Accept-Encoding' });
      res.end(compressed);
    });
  } else {
    res.writeHead(statusCode, headers);
    res.end(body);
  }
}

function formatDate(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.valueOf())) return iso;
  return new Intl.DateTimeFormat('es-ES', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'Europe/Madrid',
  }).format(date);
}

function renderAdminPage(nonce = '') {
  const rows = recentLeads.map((lead) => `
      <tr>
        <td>${escapeHtml(formatDate(lead.createdAt))}</td>
        <td>${escapeHtml(lead.nombre)}</td>
        <td><a href="mailto:${escapeHtml(lead.email)}">${escapeHtml(lead.email)}</a></td>
        <td>${escapeHtml(lead.telefono || '—')}</td>
        <td>${escapeHtml(lead.tipoLabel)}</td>
        <td>${escapeHtml(lead.identifier || lead.issueId || '—')}</td>
      </tr>
  `).join('');

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Admin · Lex</title>
  <style nonce="${nonce}">
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f6f7fb; color: #111827; }
    .wrap { max-width: 1100px; margin: 0 auto; padding: 24px; }
    .card { background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; box-shadow: 0 1px 2px rgba(0,0,0,0.04); overflow: hidden; }
    .head { padding: 20px; border-bottom: 1px solid #e5e7eb; }
    h1 { margin: 0 0 8px; font-size: 1.4rem; }
    .meta { margin: 0; color: #6b7280; font-size: 0.9rem; }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 0.92rem; }
    th, td { text-align: left; padding: 12px 14px; border-bottom: 1px solid #f3f4f6; white-space: nowrap; }
    th { background: #f9fafb; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.06em; color: #6b7280; }
    a { color: #1d4ed8; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .empty { padding: 16px 20px; color: #6b7280; }
  </style>
</head>
<body>
  <main class="wrap">
    <section class="card">
      <header class="head">
        <h1>Panel de administración</h1>
        <p class="meta">Leads recientes recibidos desde la landing (últimos ${MAX_RECENT_LEADS}).</p>
      </header>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Nombre</th>
              <th>Email</th>
              <th>Teléfono</th>
              <th>Tipo</th>
              <th>Issue</th>
            </tr>
          </thead>
          <tbody>
            ${rows || '<tr><td class="empty" colspan="6">Sin leads todavía.</td></tr>'}
          </tbody>
        </table>
      </div>
    </section>
  </main>
</body>
</html>`;
}

function markdownToHtml(text) {
  if (!text) return '';
  const lines = text.split('\n');
  const out = [];
  let inList = false;
  let inPara = false;

  const esc = (s) => escapeHtml(s);
  const inline = (s) => s
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*([^*\n]+)\*/g, '<em>$1</em>');

  const closePara = () => { if (inPara) { out.push('</p>'); inPara = false; } };
  const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      closeList(); closePara();
      continue;
    }
    if (/^\*{3,}$|^-{3,}$|^_{3,}$/.test(line.trim())) {
      closeList(); closePara();
      out.push('<hr />');
      continue;
    }
    const hm = line.match(/^(#{1,4}) (.+)/);
    if (hm) {
      closeList(); closePara();
      const level = Math.min(hm[1].length + 1, 5); // # → h2, ## → h3, ### → h4, #### → h5
      out.push(`<h${level}>${inline(esc(hm[2]))}</h${level}>`);
      continue;
    }
    if (line.match(/^>\s/)) {
      closeList(); closePara();
      out.push(`<blockquote>${inline(esc(line.slice(2)))}</blockquote>`);
      continue;
    }
    if (line.match(/^[*-] /)) {
      closePara();
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inline(esc(line.slice(2)))}</li>`);
      continue;
    }
    closeList();
    if (!inPara) { out.push('<p>'); inPara = true; } else { out.push(' '); }
    out.push(inline(esc(line)));
  }
  closeList(); closePara();
  return out.join('\n');
}

function renderLegalPage(title, markdownBody, nonce = '', canonicalPath = '') {
  const bodyHtml = markdownToHtml(markdownBody) || '<p>Contenido no disponible.</p>';
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex, follow" />
  ${canonicalPath ? `<link rel="canonical" href="${SITE_URL}${canonicalPath}" />` : ''}
  <title>${escapeHtml(title)} · LexReclama</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
  <link rel="icon" href="/favicon.svg" sizes="any" />
  <link rel="apple-touch-icon" href="/logo-avatar.png" />
  ${renderGa4Snippet(nonce)}
  <style nonce="${nonce}">
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f8fafc; color: #0f172a; }
    .wrap { max-width: 860px; margin: 0 auto; padding: 24px; }
    .top { margin-bottom: 16px; }
    .top a { color: #1d4ed8; text-decoration: none; font-size: 0.95rem; }
    .top a:hover { text-decoration: underline; }
    .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 28px 32px; }
    h1 { font-size: 1.55rem; margin: 0 0 24px; padding-bottom: 16px; border-bottom: 1px solid #e2e8f0; }
    h2 { font-size: 1.25rem; margin: 28px 0 10px; color: #1e293b; }
    h3 { font-size: 1.05rem; margin: 20px 0 8px; color: #334155; }
    h4, h5 { font-size: 0.95rem; margin: 16px 0 6px; color: #475569; }
    p { margin: 0 0 12px; line-height: 1.65; font-size: 0.93rem; color: #334155; }
    ul { margin: 0 0 12px 20px; padding: 0; }
    li { margin: 4px 0; line-height: 1.6; font-size: 0.93rem; color: #334155; }
    blockquote { margin: 16px 0; padding: 12px 16px; background: #fef9c3; border-left: 3px solid #ca8a04; border-radius: 4px; font-size: 0.9rem; }
    hr { border: none; border-top: 1px solid #e2e8f0; margin: 24px 0; }
    strong { color: #0f172a; }
  </style>
</head>
<body>
  <main class="wrap">
    <div class="top"><a href="/">← Volver a inicio</a></div>
    <article class="card">
      <h1>${escapeHtml(title)}</h1>
      ${bodyHtml}
    </article>
  </main>
</body>
</html>`;
}

function handleLegalPage(req, res, pathname, nonce = '') {
  const page = LEGAL_PAGES[pathname];
  if (!page) return false;
  const html = renderLegalPage(page.title, page.body, nonce, pathname);
  sendCompressed(req, res, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' }, Buffer.from(html));
  return true;
}

async function handleAdmin(req, res, nonce = '') {
  if (!ADMIN_PASSWORD) {
    logAdminAudit(req, 'admin_disabled', 'ADMIN_PASSWORD_missing');
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('ADMIN_PASSWORD is not configured');
    return;
  }

  if (!isAdminAuthorized(req, { adminUser: ADMIN_USER, adminPassword: ADMIN_PASSWORD, safeEqual })) {
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

async function handleSubmitLead(req, res) {
  const body = req.parsedBody;
  const uploadedFiles = req.uploadedFiles || [];

  const leadData = normalizeLeadPayload(body);
  if (!leadData.ok) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: leadData.error }));
    return;
  }

  if (requiresUpfrontPayment(leadData.value.tipo)) {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Este tipo requiere pago previo. Inicia checkout primero.' }));
    return;
  }

  // Silently discard test leads so they don't pollute the claims manager queue.
  const testLeadReason = detectTestLeadReason(leadData.value);
  if (testLeadReason) {
    console.log(`[test-lead] silently discarded (${testLeadReason}): ${maskEmail(leadData.value.email)}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, issueId: null, identifier: null, deduplicated: false, test: true }));
    return;
  }

  try {
    const result = await resolveIdempotentRequest({
      scope: 'submit-lead',
      key: leadData.value.idempotencyKey,
      store: recentLeadSubmissions,
      execute: async () => {
        const created = await createIssueForLead(leadData.value, { paid: false });
        // Upload files to OCR server after issue is created
        if (uploadedFiles.length > 0) {
          for (const file of uploadedFiles) {
            await uploadDocumentToOcr(created.id, file);
          }
        }
        return { issueId: created.id, identifier: created.identifier };
      },
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      issueId: result.value.issueId,
      identifier: result.value.identifier,
      deduplicated: result.deduplicated,
    }));
  } catch (err) {
    console.error('Lead submission error:', err.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No se pudo procesar la solicitud en este momento.' }));
  }
}

function normalizeApiLeadPayload(body) {
  const nombre = String(body?.nombre || '').trim();
  const email = String(body?.email || '').trim();
  const tipoReclamacion = String(body?.tipo_reclamacion || body?.tipo || '').trim().toLowerCase();
  const descripcion = String(body?.descripcion || '').trim();

  if (!nombre || !email || !tipoReclamacion) {
    return { ok: false, error: 'Campos requeridos: nombre, email y tipo_reclamacion' };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: 'Dirección de email inválida' };
  }
  if (nombre.length > 120) return { ok: false, error: 'Nombre demasiado largo' };
  if (email.length > 254) return { ok: false, error: 'Email demasiado largo' };
  if (descripcion.length > 4000) return { ok: false, error: 'Descripción demasiado larga (máx. 4000 caracteres)' };

  const payload = {
    ...body,
    nombre,
    email,
    tipo: tipoReclamacion,
    descripcion,
    privacidadAceptada: body?.privacidadAceptada === true || String(body?.privacidadAceptada || '').toLowerCase() === 'true',
    comercialAceptada: body?.comercialAceptada === true || String(body?.comercialAceptada || '').toLowerCase() === 'true',
    consentimientoTimestamp: String(body?.consentimientoTimestamp || '').trim() || new Date().toISOString(),
    versionPolitica: String(body?.versionPolitica || '').trim() || PRIVACY_POLICY_VERSION,
    idempotencyKey: String(body?.idempotencyKey || '').trim() || '',
  };

  if (!payload.privacidadAceptada) {
    return { ok: false, error: 'Debes aceptar la política de privacidad' };
  }

  return { ok: true, value: payload };
}

async function handleApiLead(req, res) {
  const basePayload = normalizeApiLeadPayload(req.parsedBody || {});
  if (!basePayload.ok) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: basePayload.error }));
    return;
  }

  req.parsedBody = basePayload.value;
  req.uploadedFiles = [];
  await handleSubmitLead(req, res);
}

function requiresUpfrontPayment(tipo) {
  return tipo in PAID_CLAIM_TYPES;
}

function normalizeLeadPayload(body) {
  const nombre = String(body?.nombre || '').trim();
  const email = String(body?.email || '').trim();
  const telefono = String(body?.telefono || '').trim();
  const tipo = String(body?.tipo || '').trim();
  const descripcion = String(body?.descripcion || '').trim();
  const privacidadAceptada = body?.privacidadAceptada === true;
  const comercialAceptada = body?.comercialAceptada === true;
  const consentimientoTimestamp = String(body?.consentimientoTimestamp || '').trim();
  const versionPolitica = String(body?.versionPolitica || '').trim();
  const idempotencyKey = String(body?.idempotencyKey || '').trim();

  if (!nombre || !email || !tipo || !privacidadAceptada || !consentimientoTimestamp || !versionPolitica) {
    return { ok: false, error: 'Campos requeridos: nombre, email, tipo y consentimiento RGPD' };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: 'Dirección de email inválida' };
  }
  if (nombre.length > 120) return { ok: false, error: 'Nombre demasiado largo' };
  if (email.length > 254) return { ok: false, error: 'Email demasiado largo' };
  if (telefono.length > 30) return { ok: false, error: 'Teléfono demasiado largo' };
  if (descripcion.length > 4000) return { ok: false, error: 'Descripción demasiado larga (máx. 4000 caracteres)' };
  if (idempotencyKey && idempotencyKey.length > 128) {
    return { ok: false, error: 'idempotencyKey inválida' };
  }

  const ALLOWED_TIPOS = ['deuda', 'banco', 'multa', 'otro'];
  if (!ALLOWED_TIPOS.includes(tipo)) {
    return { ok: false, error: 'Tipo de reclamación no válido' };
  }

  const tipoLabel = {
    deuda: 'Reclamación de deuda impagada',
    banco: 'Cláusulas bancarias abusivas',
    multa: 'Impugnación de multa',
    otro: 'Consulta general',
  }[tipo];

  // Vertical-specific fields (all optional; capped to prevent oversized issues)
  const str = (v, max = 200) => String(body?.[v] || '').trim().slice(0, max);
  let vertical = {};
  if (tipo === 'multa') {
    vertical = {
      multa_expediente: str('multa_expediente', 60),
      multa_importe: str('multa_importe', 20),
      multa_fecha: str('multa_fecha', 20),
      multa_tipo_infraccion: str('multa_tipo_infraccion', 200),
      multa_organismo: str('multa_organismo', 100),
    };
  } else if (tipo === 'banco') {
    vertical = {
      banco_tipo_clausula: str('banco_tipo_clausula', 80),
      banco_nombre: str('banco_nombre', 100),
      banco_anio_firma: str('banco_anio_firma', 6),
      banco_cuota_mensual: str('banco_cuota_mensual', 20),
    };
  } else if (tipo === 'deuda') {
    vertical = {
      deuda_tipo_deuda: str('deuda_tipo_deuda', 80),
      deuda_importe_reclamado: str('deuda_importe_reclamado', 20),
      deuda_nombre_deudor: str('deuda_nombre_deudor', 200),
      deuda_tiene_contrato: str('deuda_tiene_contrato', 10),
    };
  }

  return {
    ok: true,
    value: {
      nombre,
      email,
      telefono,
      tipo,
      tipoLabel,
      descripcion,
      privacidadAceptada,
      comercialAceptada,
      consentimientoTimestamp,
      versionPolitica,
      idempotencyKey,
      ...vertical,
    },
  };
}

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

async function handleCreateCheckoutSession(req, res) {
  const body = req.parsedBody;

  const leadData = normalizeLeadPayload(body);
  if (!leadData.ok) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: leadData.error }));
    return;
  }

  if (!requiresUpfrontPayment(leadData.value.tipo)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Este tipo no requiere checkout previo' }));
    return;
  }

  sweepPendingCheckoutLeads();

  try {
    const result = await resolveIdempotentRequest({
      scope: 'create-checkout-session',
      key: leadData.value.idempotencyKey,
      store: recentCheckoutCreations,
      execute: async () => {
        const leadToken = crypto.randomUUID();
        const stripeSession = await createStripeCheckoutSession(req, leadToken, leadData.value);
        pendingCheckoutLeads.set(leadToken, {
          leadData: leadData.value,
          createdAtMs: Date.now(),
          stripeSessionId: stripeSession.id,
        });
        return {
          leadToken,
          checkoutUrl: stripeSession.url,
          checkoutSessionId: stripeSession.id,
        };
      },
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      leadToken: result.value.leadToken,
      checkoutUrl: result.value.checkoutUrl,
      checkoutSessionId: result.value.checkoutSessionId,
      deduplicated: result.deduplicated,
    }));
  } catch (err) {
    console.error('Stripe checkout session error:', err.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No se pudo iniciar el proceso de pago. Inténtalo de nuevo en unos minutos.' }));
  }
}

async function handleConfirmCheckout(req, res) {
  const body = req.parsedBody;

  const leadToken = String(body?.leadToken || '').trim();
  const sessionId = String(body?.sessionId || '').trim();
  if (!leadToken || !sessionId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'leadToken y sessionId son obligatorios' }));
    return;
  }

  const completed = completedCheckoutLeads.get(leadToken);
  if (completed) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, issueId: completed.issueId, identifier: completed.identifier, deduplicated: true }));
    return;
  }

  const pending = pendingCheckoutLeads.get(leadToken);
  if (!pending) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'La sesión de checkout no existe o ha expirado' }));
    return;
  }
  if (pending.stripeSessionId !== sessionId) {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'sessionId no coincide con el checkout pendiente' }));
    return;
  }

  try {
    const stripeSession = await readStripeCheckoutSession(sessionId);
    const paid = stripeSession.payment_status === 'paid';
    const tokenMatches = String(stripeSession.metadata?.leadToken || '') === leadToken;
    if (!paid || !tokenMatches) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Pago aún no confirmado por Stripe' }));
      return;
    }

    const amountLabel = PAID_CLAIM_TYPES[pending.leadData.tipo]?.baseAmountLabel || 'importe inicial';
    const issue = await createIssueForLead(pending.leadData, {
      paid: true,
      amountLabel,
      checkoutSessionId: stripeSession.id,
    });

    const payload = { issueId: issue.id, identifier: issue.identifier, completedAtMs: Date.now() };
    completedCheckoutLeads.set(leadToken, payload);
    pendingCheckoutLeads.delete(leadToken);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, issueId: payload.issueId, identifier: payload.identifier }));
  } catch (err) {
    console.error('Confirm checkout error:', err.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No se pudo confirmar el pago en este momento.' }));
  }
}

function normalizeSubscribePayload(payload) {
  const email = String(payload?.email || '').trim().toLowerCase();
  const nombre = String(payload?.nombre || '').trim();
  const tipoReclamacion = String(payload?.tipo_reclamacion || '').trim().toLowerCase();
  const privacidadAceptada = payload?.privacidadAceptada === true || String(payload?.privacidadAceptada || '').toLowerCase() === 'true';
  const consentimientoTimestamp = String(payload?.consentimientoTimestamp || '').trim();
  const versionPolitica = String(payload?.versionPolitica || '').trim();
  const leadMagnet = String(payload?.leadMagnet || '').trim().toLowerCase();
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  if (!emailOk) return { ok: false, error: 'Email no válido' };
  if (nombre.length > 120) return { ok: false, error: 'Nombre demasiado largo' };
  if (tipoReclamacion.length > 80) return { ok: false, error: 'Tipo de reclamación demasiado largo' };
  if (leadMagnet.length > 80) return { ok: false, error: 'Lead magnet no válido' };
  if (!privacidadAceptada || !consentimientoTimestamp || !versionPolitica) {
    return { ok: false, error: 'Debes aceptar la política de privacidad para suscribirte' };
  }
  if (leadMagnet && leadMagnet !== 'guia-bancaria') {
    return { ok: false, error: 'Lead magnet no soportado' };
  }
  return {
    ok: true,
    value: {
      email,
      nombre,
      tipoReclamacion,
      leadMagnet,
      privacidadAceptada,
      consentimientoTimestamp,
      versionPolitica,
    },
  };
}

async function handleSubscribe(req, res) {
  const parsed = normalizeSubscribePayload(req.parsedBody);
  if (!parsed.ok) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: parsed.error }));
    return;
  }

  // Silently discard test/invalid addresses so they don't hit Brevo and return 5xx.
  const testLeadReason = detectTestLeadReason(parsed.value);
  if (testLeadReason) {
    console.log(`[test-lead] subscribe silently discarded (${testLeadReason}): ${maskEmail(parsed.value.email)}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  try {
    await subscribeContactInBrevo(parsed.value);
    try {
      await sendLeadMagnetEmail(parsed.value);
    } catch (emailErr) {
      console.error(`[lead-magnet] email send failed for ${parsed.value.email}: ${emailErr.message}`);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const response = { success: true };
    if (parsed.value.leadMagnet === 'guia-bancaria') {
      response.downloadUrl = LEAD_MAGNET_PDF_PATH;
    }
    res.end(JSON.stringify(response));
  } catch (err) {
    const message = String(err?.message || 'Error al suscribirse').toLowerCase();
    const status = message.includes('brevo_api_key no configurada') ? 503 : 502;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No se pudo completar la suscripción ahora mismo.' }));
  }
}

function parseBearerToken(req) {
  const header = String(req.headers.authorization || '').trim();
  if (!header.startsWith('Bearer ')) return '';
  return header.slice(7).trim();
}

async function readIssueDocumentsIndex(issueId) {
  const folder = path.join(DOCUMENTS_DIR, String(issueId || '').trim());
  // Defense-in-depth: ensure folder is still inside DOCUMENTS_DIR even if issueId
  // contained path-traversal sequences (primary guard is at the session layer).
  if (!folder.startsWith(DOCUMENTS_DIR + path.sep) && folder !== DOCUMENTS_DIR) return [];
  const indexPath = path.join(folder, 'index.json');
  try {
    const raw = await fs.promises.readFile(indexPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((doc) => {
      const fileId = String(doc?.fileId || '').trim();
      const originalPath = String(doc?.originalPath || '').trim();
      return {
        fileId,
        name: String(doc?.filename || 'Documento'),
        mimeType: String(doc?.mimeType || 'application/octet-stream'),
        size: Number(doc?.size || 0),
        createdAt: String(doc?.createdAt || ''),
        originalPath,
      };
    }).filter((doc) => doc.fileId && doc.originalPath.startsWith(folder));
  } catch {
    return [];
  }
}

async function handleAdminPortalTestCode(req, res, url) {
  const caseId = normalizeCaseIdentifier(url.searchParams.get('caseId'));
  if (!isCaseIdentifierValid(caseId)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Numero de caso invalido' }));
    return;
  }
  const issue = await fetchIssueByIdentifier(caseId);
  if (!issue) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Expediente no encontrado' }));
    return;
  }
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const salt = crypto.randomBytes(8).toString('hex');
  const hash = crypto.createHash('sha256').update(`${salt}:${code}`).digest('hex');
  portalAuthCodes.set(caseId, {
    issueId: issue.id,
    email: extractClientEmail(issue) || 'test@lexreclama.es',
    codeHash: hash,
    salt,
    attempts: 0,
    used: false,
    expiresAtMs: Date.now() + PORTAL_CODE_TTL_MS,
    adminTest: true,
  });
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ ok: true, caseId, code, expiresInSec: Math.floor(PORTAL_CODE_TTL_MS / 1000) }));
}

async function handlePortalRequestCode(req, res) {
  runPortalStateSweep();
  const caseId = normalizeCaseIdentifier(req.parsedBody?.caseId);
  if (!isCaseIdentifierValid(caseId)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Numero de caso invalido' }));
    return;
  }

  // If an active admin test code exists for this caseId, don't overwrite it.
  const existingAdminCode = portalAuthCodes.get(caseId);
  if (existingAdminCode && existingAdminCode.adminTest && !existingAdminCode.used && existingAdminCode.expiresAtMs > Date.now()) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      maskedEmail: maskEmail(existingAdminCode.email),
      expiresInSec: Math.floor((existingAdminCode.expiresAtMs - Date.now()) / 1000),
    }));
    return;
  }

  const issue = await fetchIssueByIdentifier(caseId);
  const email = issue ? extractClientEmail(issue) : null;
  if (!issue || !email) {
    await new Promise((resolve) => setTimeout(resolve, 200 + Math.random() * 100));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      maskedEmail: null,
      expiresInSec: Math.floor(PORTAL_CODE_TTL_MS / 1000),
    }));
    return;
  }

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const salt = crypto.randomBytes(8).toString('hex');
  const hash = crypto.createHash('sha256').update(`${salt}:${code}`).digest('hex');
  portalAuthCodes.set(caseId, {
    issueId: issue.id,
    email,
    codeHash: hash,
    salt,
    attempts: 0,
    used: false,
    expiresAtMs: Date.now() + PORTAL_CODE_TTL_MS,
  });

  const sent = await sendPortalCodeEmail(email, caseId, code);
  if (!sent) {
    console.warn(`[portal] codigo 2FA generado para ${caseId} pero no enviado por Brevo`);
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    ok: true,
    maskedEmail: maskEmail(email),
    expiresInSec: Math.floor(PORTAL_CODE_TTL_MS / 1000),
  }));
}

async function handlePortalVerifyCode(req, res) {
  const caseId = normalizeCaseIdentifier(req.parsedBody?.caseId);
  const code = String(req.parsedBody?.code || '').trim();
  const auth = portalAuthCodes.get(caseId);
  if (!auth || auth.used || auth.expiresAtMs <= Date.now()) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Codigo invalido o expirado' }));
    return;
  }
  if (!/^\d{6}$/.test(code)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Formato de codigo invalido' }));
    return;
  }

  const codeHash = crypto.createHash('sha256').update(`${auth.salt}:${code}`).digest('hex');
  if (codeHash !== auth.codeHash) {
    auth.attempts += 1;
    if (auth.attempts >= 5) auth.used = true;
    portalAuthCodes.set(caseId, auth);
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Codigo incorrecto' }));
    return;
  }

  const token = crypto.randomBytes(32).toString('hex');
  portalSessions.set(token, {
    caseId,
    issueId: auth.issueId,
    email: auth.email,
    expiresAtMs: Date.now() + PORTAL_SESSION_TTL_MS,
  });
  auth.used = true;
  portalAuthCodes.set(caseId, auth);

  appendSetCookieHeader(
    res,
    buildPortalSessionCookieHeader(token, Math.floor(PORTAL_SESSION_TTL_MS / 1000)),
  );
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    ok: true,
    expiresAt: new Date(Date.now() + PORTAL_SESSION_TTL_MS).toISOString(),
  }));
}

async function handlePortalMe(req, res) {
  const auth = getPortalSession(req);
  if (!auth) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Sesion invalida o expirada' }));
    return;
  }
  // Sliding renewal: extend session on each active use
  auth.session.expiresAtMs = Date.now() + PORTAL_SESSION_TTL_MS;
  appendSetCookieHeader(res, buildPortalSessionCookieHeader(auth.token, Math.floor(PORTAL_SESSION_TTL_MS / 1000)));
  const issueRes = await fetchWithTimeout(`${PAPERCLIP_API}/api/issues/${encodeURIComponent(auth.session.issueId)}`, {
    headers: {
      Authorization: `Bearer ${SUBMIT_API_KEY}`,
    },
  }, FETCH_TIMEOUT_API_MS);
  const issue = await issueRes.json().catch(() => null);
  if (!issueRes.ok || !issue) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Caso no disponible' }));
    return;
  }

  const apiMessages = await fetchIssueComments(auth.session.issueId);
  const localMessages = portalMessages.get(auth.session.caseId) || [];
  const allMessages = [...apiMessages.slice(0, 5), ...localMessages].slice(-8);
  const rawDocuments = await readIssueDocumentsIndex(auth.session.issueId);
  const documents = rawDocuments.map((doc) => ({
    id: doc.fileId,
    name: doc.name,
    mimeType: doc.mimeType,
    size: doc.size,
    createdAt: doc.createdAt,
    url: `/api/portal/cases/${encodeURIComponent(auth.session.caseId)}/documents/${encodeURIComponent(doc.fileId)}`,
  }));
  const portalCase = mapIssueToPortalCase(issue, allMessages.length ? allMessages : [{ author: 'Despacho', body: 'Tu caso esta en seguimiento. Te notificaremos cualquier cambio.' }]);
  portalCase.documents = documents;

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    ok: true,
    session: {
      caseId: auth.session.caseId,
      expiresAt: new Date(auth.session.expiresAtMs).toISOString(),
    },
    cases: [portalCase],
  }));
}

async function handlePortalLogout(req, res) {
  const token = parsePortalSessionTokenFromRequest(req);
  if (token) portalSessions.delete(token);
  appendSetCookieHeader(res, buildPortalSessionCookieHeader('', 0));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

async function handlePortalCaseMessage(req, res, caseIdRaw) {
  const auth = getPortalSession(req);
  if (!auth) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Sesion invalida o expirada' }));
    return;
  }
  const caseId = normalizeCaseIdentifier(caseIdRaw);
  if (caseId !== auth.session.caseId) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No autorizado para este caso' }));
    return;
  }
  const message = String(req.parsedBody?.message || '').trim();
  if (!message || message.length > 1000) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Mensaje invalido' }));
    return;
  }
  const current = portalMessages.get(caseId) || [];
  current.push({ author: 'Cliente', fromClient: true, body: message, createdAt: new Date().toISOString() });
  portalMessages.set(caseId, current.slice(-12));

  if (SUBMIT_API_KEY) {
    await fetchWithTimeout(`${PAPERCLIP_API}/api/issues/${encodeURIComponent(auth.session.issueId)}/comments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SUBMIT_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        body: `[CLIENTE]\n\n${message}`,
      }),
    }, FETCH_TIMEOUT_API_MS).catch((err) => {
      console.warn(`[portal] mensaje de ${caseId} no sincronizado a Paperclip: ${err.message}`);
    });
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

async function handlePortalCaseDocumentDownload(req, res, caseIdRaw, fileIdRaw) {
  const auth = getPortalSession(req);
  if (!auth) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Sesion invalida o expirada' }));
    return;
  }
  const caseId = normalizeCaseIdentifier(caseIdRaw);
  if (caseId !== auth.session.caseId) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No autorizado para este caso' }));
    return;
  }

  const fileId = String(fileIdRaw || '').trim();
  if (!/^[a-zA-Z0-9-]{8,}$/.test(fileId)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Documento invalido' }));
    return;
  }

  const docs = await readIssueDocumentsIndex(auth.session.issueId);
  const selected = docs.find((doc) => doc.fileId === fileId);
  if (!selected) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Documento no encontrado' }));
    return;
  }
  const normalizedFile = path.normalize(selected.originalPath);
  const issueFolder = path.normalize(path.join(DOCUMENTS_DIR, String(auth.session.issueId)));
  if (!normalizedFile.startsWith(issueFolder)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Ruta no autorizada' }));
    return;
  }

  let stat;
  try {
    stat = await fs.promises.stat(normalizedFile);
    if (!stat.isFile()) throw new Error('not_file');
  } catch {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Archivo no disponible' }));
    return;
  }

  const safeName = String(selected.name || 'documento').replace(/[\r\n"\\]/g, '_').slice(0, 180);
  const asciiName = safeName.replace(/[^\x20-\x7E]/g, '_');
  res.writeHead(200, {
    'Content-Type': selected.mimeType || 'application/octet-stream',
    'Content-Length': String(stat.size),
    'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`,
    'Cache-Control': 'private, no-store',
  });
  fs.createReadStream(normalizedFile).pipe(res);
}

const PAGE_404_PATH = path.join(STATIC_DIR, '404.html');
const BLOCKED_PREFIXES = ['/social-templates/', '/social-templates', '/utils/', '/utils', '/middleware/', '/middleware', '/routes/', '/routes', '/services/', '/services', '/node_modules/', '/node_modules'];
const BLOCKED_FILENAMES = new Set(['server.js', 'package.json', 'package-lock.json', 'start.sh', 'ensure-running.sh', 'legal-texts.md', 'logo-preview.html', 'design-system.html']);

function send404(req, res, csrfToken = '', nonce = '') {
  fs.readFile(PAGE_404_PATH, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const body = Buffer.from(injectRuntimeSnippets(data.toString('utf8'), csrfToken, nonce));
    const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' };
    sendCompressed(req, res, headers, body, 404);
  });
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

  if (await routeSubscribeEndpoint({
    req,
    res,
    url,
    getClientIp,
    consumeRateLimit,
    rateLimitRules: RATE_LIMIT_RULES,
    validateCsrfToken,
    handlers: {
      handleSubscribe,
    },
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

  // Static file serving
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, {
      'Content-Type': 'text/plain; charset=utf-8',
      Allow: 'GET, HEAD',
    });
    res.end('Method Not Allowed');
    return;
  }

  // Block internal/build directories from public access
  if (BLOCKED_PREFIXES.some((p) => url.pathname === p || url.pathname.startsWith(p + '/'))) {
    send404(req, res, csrfToken, nonce); return;
  }

  // Security: block dotfiles (e.g. /.env, /.gitignore) and server-side source files
  const segments = url.pathname.split('/');
  const hasDotSegment = segments.some((s) => s.startsWith('.') && s.length > 1);
  const lastSegment = segments[segments.length - 1] || '';
  // Block internal file types — sources/drafts/configs/logs are not public assets
  const hasBlockedExtension = lastSegment.endsWith('.md')
    || lastSegment.endsWith('.log')
    || lastSegment.endsWith('.conf')
    || lastSegment.endsWith('.sh')
    || lastSegment.endsWith('.php')
    || lastSegment.endsWith('.asp')
    || lastSegment.endsWith('.aspx')
    || lastSegment.endsWith('.jsp');
  if (hasDotSegment || BLOCKED_FILENAMES.has(lastSegment) || hasBlockedExtension) {
    send404(req, res, csrfToken, nonce); return;
  }

  let filePath = path.join(STATIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname);
  // Security: prevent path traversal
  if (!filePath.startsWith(STATIC_DIR + path.sep) && filePath !== STATIC_DIR) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Forbidden'); return;
  }

  fs.stat(filePath, (statErr, stats) => {
    if (!statErr && stats.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        send404(req, res, csrfToken, nonce); return;
      }
      const ext = path.extname(filePath);
      const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
      if (ext === '.css' || ext === '.js') {
        headers['Cache-Control'] = 'public, max-age=31536000, immutable';
      } else if (ext && ext !== '.html') {
        // Non-hashed static assets (logos, favicons, images, fonts, docs) should be cacheable,
        // but with a shorter TTL so branding/content updates propagate quickly.
        headers['Cache-Control'] = 'public, max-age=86400';
      }
      if (ext === '.html') {
        const body = Buffer.from(injectRuntimeSnippets(data.toString('utf8'), csrfToken, nonce));
        sendCompressed(req, res, headers, body);
        return;
      }
      if (COMPRESSIBLE_EXTS.has(ext)) {
        sendCompressed(req, res, headers, data);
        return;
      }
      res.writeHead(200, headers);
      res.end(data);
    });
  });
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
