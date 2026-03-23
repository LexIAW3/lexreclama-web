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

const PORT = Number(process.env.PORT) || 8080;
const STATIC_DIR = __dirname;
const BLOG_DIR = path.join(__dirname, 'blog');
const LEGAL_TEXTS_PATH = path.join(__dirname, 'legal-texts.md');
const PAPERCLIP_API = process.env.PAPERCLIP_API_URL || 'http://127.0.0.1:3100';
const OCR_SERVER = process.env.OCR_SERVER_URL || 'http://127.0.0.1:3200';
const DOCUMENTS_DIR = path.join(__dirname, '..', 'documents');
const SITE_URL = 'https://www.lexreclama.es';
const SUBMIT_API_KEY = process.env.PAPERCLIP_SUBMIT_KEY;
const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID;
const STRIPE_SECRET_KEY = (process.env.STRIPE_SECRET_KEY || '').trim();
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const GA4_MEASUREMENT_ID = (process.env.GA4_MEASUREMENT_ID || '').trim();
const GOOGLE_ADS_ID = (process.env.GOOGLE_ADS_ID || '').trim();
const GOOGLE_ADS_CONVERSION_LABEL = (process.env.GOOGLE_ADS_CONVERSION_LABEL || '').trim();
const WHATSAPP_NUMBER = (process.env.WHATSAPP_NUMBER || '').trim();
const BREVO_API_KEY = (process.env.BREVO_API_KEY || '').trim();
const BREVO_LIST_ID = Number.parseInt(process.env.BREVO_LIST_ID || '3', 10);
const BREVO_API_BASE = 'https://api.brevo.com/v3';
const GESTOR_AGENT_ID = '603134d1-2f20-4c99-9bec-92547dc99b43';
const GOAL_ID = '7d4f1e3f-6909-45cd-9aed-e1cfbfb4333d';
const PRIVACY_POLICY_VERSION = '2026-03';
const PRIMARY_HOST = 'lexreclama.es';
const SECONDARY_HOST = 'lexreclama.com';
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
const ASSET_CSS_HASH = computeFileHash(path.join(__dirname, 'styles.min.css'));
const ASSET_JS_HASH  = computeFileHash(path.join(__dirname, 'app.min.js'));
const STRIPE_API = 'https://api.stripe.com/v1';
const PENDING_CHECKOUT_TTL_MS = 6 * 60 * 60 * 1000;
const COMPLETED_CHECKOUT_TTL_MS = 24 * 60 * 60 * 1000;
const IDEMPOTENCY_WINDOW_MS = 60 * 1000;
const pendingCheckoutLeads = new Map();
const completedCheckoutLeads = new Map();
const recentLeadSubmissions = new Map();
const recentCheckoutCreations = new Map();
const idempotencyInFlight = new Map();
const PORTAL_CODE_TTL_MS = 10 * 60 * 1000;
const PORTAL_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const PORTAL_SESSION_COOKIE_NAME = 'lex_portal_session';
const PORTAL_COOKIE_SECURE =
  process.env.NODE_ENV === 'production'
  || String(process.env.HTTPS_ENABLED || '').trim().toLowerCase() === 'true';
const portalAuthCodes = new Map();
const portalSessions = new Map();
const portalMessages = new Map();
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

/* ─── RATE LIMITER + CSRF ────────────────────────────────────── */
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const rateLimitMap = new Map();
const RATE_LIMIT_RULES = {
  '/submit-lead': { scope: 'submit-lead', max: 5 },
  '/api/lead': { scope: 'api-lead', max: 8 },
  '/create-checkout-session': { scope: 'create-checkout-session', max: 3 },
  '/confirm-checkout': { scope: 'confirm-checkout', max: 10 },
  '/api/subscribe': { scope: 'api-subscribe', max: 12 },
  '/api/portal/request-code': { scope: 'portal-request-code', max: 6 },
  '/api/portal/verify-code': { scope: 'portal-verify-code', max: 20 },
  '/api/portal/logout': { scope: 'portal-logout', max: 30 },
  '/api/portal/cases': { scope: 'portal-cases', max: 60 },
};

const CSRF_COOKIE_NAME = 'lex_csrf_token';
const CSRF_TTL_MS = 12 * 60 * 60 * 1000;
const issuedCsrfTokens = new Map();

function parseCookies(req) {
  const header = String(req.headers.cookie || '');
  if (!header) return {};
  return header.split(';').reduce((acc, pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return acc;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    acc[key] = decodeURIComponent(value);
    return acc;
  }, {});
}

function sweepCsrfTokens() {
  const now = Date.now();
  for (const [token, expiresAtMs] of issuedCsrfTokens) {
    if (expiresAtMs <= now) issuedCsrfTokens.delete(token);
  }
}

function getOrCreateCsrfToken(req, res) {
  sweepCsrfTokens();
  const cookies = parseCookies(req);
  const cookieToken = String(cookies[CSRF_COOKIE_NAME] || '').trim();
  const now = Date.now();
  const activeExpiry = cookieToken ? issuedCsrfTokens.get(cookieToken) : 0;
  if (cookieToken && activeExpiry > now) {
    return cookieToken;
  }

  const token = crypto.randomBytes(32).toString('hex');
  issuedCsrfTokens.set(token, now + CSRF_TTL_MS);

  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const secureCookie = forwardedProto === 'https';
  const maxAge = Math.floor(CSRF_TTL_MS / 1000);
  const cookieParts = [
    `${CSRF_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'SameSite=Strict',
    `Max-Age=${maxAge}`,
  ];
  if (secureCookie) cookieParts.push('Secure');
  res.setHeader('Set-Cookie', cookieParts.join('; '));
  return token;
}

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

function validateCsrfToken(req, res) {
  return (async () => {
    const okBody = await parseMultipartOrJsonBody(req, res);
    if (!okBody) return false;
    sweepCsrfTokens();

    const cookies = parseCookies(req);
    const cookieToken = String(cookies[CSRF_COOKIE_NAME] || '').trim();
    const bodyToken = String(req.parsedBody?.csrfToken || '').trim();
    const known = bodyToken ? issuedCsrfTokens.get(bodyToken) : 0;
    const validWindow = known > Date.now();

    if (!cookieToken || !bodyToken || !safeEqual(cookieToken, bodyToken) || !validWindow) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'CSRF token inválido' }));
      return false;
    }
    return true;
  })();
}

function consumeRateLimit(rule, ip) {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const key = `${rule.scope}:${ip || 'unknown'}`;
  const current = rateLimitMap.get(key) || [];
  const validHits = current.filter((timestamp) => timestamp > windowStart);
  if (validHits.length >= rule.max) {
    const oldest = validHits[0];
    const retryAfterSec = Math.max(1, Math.ceil((oldest + RATE_LIMIT_WINDOW_MS - now) / 1000));
    rateLimitMap.set(key, validHits);
    return { limited: true, retryAfterSec };
  }
  validHits.push(now);
  rateLimitMap.set(key, validHits);
  return { limited: false, retryAfterSec: 0 };
}

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
  <link rel="stylesheet" href="/styles.min.css?v=${ASSET_CSS_HASH}" />
  ${renderGa4Snippet(nonce)}
</head>
<body>
  <nav class="nav">
    <div class="nav-inner">
      <a href="/" class="logo">LexReclama<span>.</span></a>
      <div>
        <a class="btn btn-sm" href="/reclamacion-deudas/">Deudas</a>
        <a class="btn btn-sm" href="/clausulas-bancarias/">Clausulas</a>
        <a class="btn btn-sm" href="/recurrir-multas/">Multas</a>
        <a class="btn btn-sm" href="/blog/">Blog</a>
      </div>
    </div>
  </nav>
  <main id="content-root" class="container" style="padding: 7rem 0 3rem;">
    <section>
      <p class="eyebrow">${escapeHtml(intro)}</p>
      <h1 style="font-size: clamp(2rem, 4vw, 3rem); margin: 0 0 1rem;">${escapeHtml(heading)}</h1>
      ${bodyHtml}
    </section>
  </main>
  <footer class="footer">
    <div class="container footer-inner">
      <a href="/" class="logo">LexReclama<span>.</span></a>
      <div class="footer-links">
        <a href="/aviso-legal">Aviso legal</a>
        <a href="/politica-privacidad">Politica de privacidad</a>
        <a href="/politica-cookies">Politica de cookies</a>
        <a href="/condiciones">Condiciones generales</a>
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
  return html
    .replace(/href="(\/styles\.min\.css)"/g, `href="$1?v=${ASSET_CSS_HASH}"`)
    .replace(/src="(\/app\.min\.js)"/g, `src="$1?v=${ASSET_JS_HASH}"`);
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
    : '<p>Todavia no hay articulos publicados.</p>';

  return renderContentShell({
    pageTitle: 'Blog legal',
    metaDescription: 'Hub de contenido legal sobre reclamaciones de deudas, clausulas bancarias y multas.',
    heading: 'Blog de reclamaciones legales',
    intro: 'Hub de contenido',
    bodyHtml: `<p>Articulos disponibles:</p>${items}`,
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

function buildSitemapXml() {
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
  const body = urls.map((urlPath) => `  <url><loc>${SITE_URL}${urlPath}</loc></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
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
  '/aviso-legal': {
    title: 'Aviso Legal',
    body: sectionSlice(LEGAL_TEXTS, '# 1. AVISO LEGAL', '# 2. POLÍTICA DE PRIVACIDAD'),
  },
  '/politica-privacidad': {
    title: 'Política de Privacidad',
    body: sectionSlice(LEGAL_TEXTS, '# 2. POLÍTICA DE PRIVACIDAD', '# 3. POLÍTICA DE COOKIES'),
  },
  '/politica-cookies': {
    title: 'Política de Cookies',
    body: sectionSlice(LEGAL_TEXTS, '# 3. POLÍTICA DE COOKIES', '# 4. CONDICIONES GENERALES DE CONTRATACIÓN'),
  },
  '/condiciones': {
    title: 'Condiciones Generales de Contratación',
    body: sectionSlice(LEGAL_TEXTS, '# 4. CONDICIONES GENERALES DE CONTRATACIÓN', '# 5. TEXTOS DE CONSENTIMIENTO — FORMULARIO DE CONTACTO / INTAKE'),
  },
};

function generateNonce() {
  return crypto.randomBytes(16).toString('base64url');
}

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

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

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

function isAdminAuthorized(req) {
  if (!ADMIN_PASSWORD) return false;
  const creds = parseBasicAuth(req);
  if (!creds) return false;
  return safeEqual(creds.username, ADMIN_USER) && safeEqual(creds.password, ADMIN_PASSWORD);
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
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

function renderAdminPage() {
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
  <style>
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

function renderLegalPage(title, markdownBody, nonce = '') {
  const bodyHtml = markdownToHtml(markdownBody) || '<p>Contenido no disponible.</p>';
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex, follow" />
  <title>${escapeHtml(title)} · LexReclama</title>
  ${renderGa4Snippet(nonce)}
  <style>
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
  const html = renderLegalPage(page.title, page.body, nonce);
  sendCompressed(req, res, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' }, Buffer.from(html));
  return true;
}

async function handleAdmin(req, res) {
  if (!ADMIN_PASSWORD) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('ADMIN_PASSWORD is not configured');
    return;
  }

  if (!isAdminAuthorized(req)) {
    sendAdminAuthChallenge(res);
    return;
  }

  const html = renderAdminPage();
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

async function uploadDocumentToOcr(issueId, file) {
  try {
    const FormDataNode = (await import('node:buffer')).Buffer; // just to ensure node exists
    // Build multipart manually using node's built-in capabilities
    const boundary = `----FormBoundary${crypto.randomBytes(16).toString('hex')}`;
    const CRLF = '\r\n';
    const parts = [
      `--${boundary}${CRLF}`,
      `Content-Disposition: form-data; name="file"; filename="${file.originalname}"${CRLF}`,
      `Content-Type: ${file.mimetype}${CRLF}`,
      CRLF,
    ];
    const bodyStart = Buffer.from(parts.join(''));
    const bodyEnd = Buffer.from(`${CRLF}--${boundary}--${CRLF}`);
    const fullBody = Buffer.concat([bodyStart, file.buffer, bodyEnd]);

    const ocrUrl = new URL(`/api/documents/upload?issueId=${encodeURIComponent(issueId)}`, OCR_SERVER);
    const res = await fetch(ocrUrl.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(fullBody.length),
      },
      body: fullBody,
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      console.warn(`[ocr] upload failed for ${file.originalname}: ${res.status} ${err}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn(`[ocr] upload error for ${file.originalname}: ${err.message}`);
    return null;
  }
}

async function handleSubmitLead(req, res) {
  const body = req.parsedBody;
  const uploadedFiles = req.uploadedFiles || [];

  const leadData = normalizeLeadPayload(body);
  if (!leadData.ok) {
    res.writeHead(400);
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
    console.log(`[test-lead] silently discarded (${testLeadReason}): ${leadData.value.email}`);
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
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
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
  if (idempotencyKey && idempotencyKey.length > 128) {
    return { ok: false, error: 'idempotencyKey inválida' };
  }

  const tipoLabel = {
    deuda: 'Reclamación de deuda impagada',
    banco: 'Cláusulas bancarias abusivas',
    multa: 'Impugnación de multa',
    otro: 'Consulta general',
  }[tipo] || tipo;

  // Vertical-specific fields
  const str = (v) => String(body?.[v] || '').trim();
  let vertical = {};
  if (tipo === 'multa') {
    vertical = {
      multa_expediente: str('multa_expediente'),
      multa_importe: str('multa_importe'),
      multa_fecha: str('multa_fecha'),
      multa_tipo_infraccion: str('multa_tipo_infraccion'),
      multa_organismo: str('multa_organismo'),
    };
  } else if (tipo === 'banco') {
    vertical = {
      banco_tipo_clausula: str('banco_tipo_clausula'),
      banco_nombre: str('banco_nombre'),
      banco_anio_firma: str('banco_anio_firma'),
      banco_cuota_mensual: str('banco_cuota_mensual'),
    };
  } else if (tipo === 'deuda') {
    vertical = {
      deuda_tipo_deuda: str('deuda_tipo_deuda'),
      deuda_importe_reclamado: str('deuda_importe_reclamado'),
      deuda_nombre_deudor: str('deuda_nombre_deudor'),
      deuda_tiene_contrato: str('deuda_tiene_contrato'),
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

function buildVerticalDescription(leadData) {
  const lines = [];
  if (leadData.tipo === 'multa') {
    lines.push('**Datos de la multa:**');
    if (leadData.multa_expediente) lines.push(`- Expediente: ${leadData.multa_expediente}`);
    if (leadData.multa_importe) lines.push(`- Importe: ${leadData.multa_importe} €`);
    if (leadData.multa_fecha) lines.push(`- Fecha notificación: ${leadData.multa_fecha}`);
    if (leadData.multa_tipo_infraccion) lines.push(`- Tipo infracción: ${leadData.multa_tipo_infraccion}`);
    if (leadData.multa_organismo) lines.push(`- Organismo: ${leadData.multa_organismo}`);
  } else if (leadData.tipo === 'banco') {
    lines.push('**Datos bancarios:**');
    if (leadData.banco_tipo_clausula) lines.push(`- Cláusula: ${leadData.banco_tipo_clausula}`);
    if (leadData.banco_nombre) lines.push(`- Banco: ${leadData.banco_nombre}`);
    if (leadData.banco_anio_firma) lines.push(`- Año firma: ${leadData.banco_anio_firma}`);
    if (leadData.banco_cuota_mensual) lines.push(`- Cuota mensual: ${leadData.banco_cuota_mensual} €`);
  } else if (leadData.tipo === 'deuda') {
    lines.push('**Datos de la deuda:**');
    if (leadData.deuda_tipo_deuda) lines.push(`- Tipo: ${leadData.deuda_tipo_deuda}`);
    if (leadData.deuda_importe_reclamado) lines.push(`- Importe: ${leadData.deuda_importe_reclamado} €`);
    if (leadData.deuda_nombre_deudor) lines.push(`- Deudor: ${leadData.deuda_nombre_deudor}`);
    if (leadData.deuda_tiene_contrato) lines.push(`- Contrato/factura: ${leadData.deuda_tiene_contrato === 'si' ? 'Sí' : 'No'}`);
  }
  return lines.length > 1 ? lines : [];
}

async function createIssueForLead(leadData, paymentMeta = { paid: false }) {
  const verticalLines = buildVerticalDescription(leadData);
  const issue = {
    title: `Lead: ${leadData.tipoLabel} — ${leadData.nombre}`,
    description: [
      `**Tipo de reclamación:** ${leadData.tipoLabel}`,
      `**Nombre:** ${leadData.nombre}`,
      `**Email:** ${leadData.email}`,
      leadData.telefono ? `**Teléfono:** ${leadData.telefono}` : null,
      `**Consentimiento privacidad:** ${leadData.privacidadAceptada ? 'Sí' : 'No'}`,
      `**Consentimiento comercial:** ${leadData.comercialAceptada ? 'Sí' : 'No'}`,
      `**Timestamp consentimiento:** ${leadData.consentimientoTimestamp}`,
      `**Versión política aceptada:** ${leadData.versionPolitica}`,
      ...(verticalLines.length ? ['', ...verticalLines] : []),
      '',
      '**Descripción del caso:**',
      leadData.descripcion || '(sin descripción)',
      '',
      paymentMeta.paid
        ? `**Pago inicial:** Confirmado (${paymentMeta.amountLabel || 'Stripe Checkout'})`
        : '**Pago inicial:** No requerido',
      paymentMeta.checkoutSessionId ? `**Stripe checkout session:** ${paymentMeta.checkoutSessionId}` : null,
      '',
      '---',
      '*Lead recibido desde la landing page web.*',
    ].filter((line) => line !== null).join('\n'),
    status: 'todo',
    priority: 'medium',
    assigneeAgentId: GESTOR_AGENT_ID,
    goalId: GOAL_ID,
  };

  const apiRes = await fetch(`${PAPERCLIP_API}/api/companies/${COMPANY_ID}/issues`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SUBMIT_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(issue),
  });
  const data = await apiRes.json();
  if (!apiRes.ok) throw new Error(data.error || `HTTP ${apiRes.status}`);

  recentLeads.unshift({
    createdAt: new Date().toISOString(),
    nombre: leadData.nombre,
    email: leadData.email,
    telefono: leadData.telefono,
    tipoLabel: leadData.tipoLabel,
    issueId: data.id || null,
    identifier: data.identifier || null,
  });
  if (recentLeads.length > MAX_RECENT_LEADS) recentLeads.length = MAX_RECENT_LEADS;
  return data;
}

function getBaseUrl(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const host = String(req.headers.host || '').trim();
  const defaultProtocol = host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https';
  const protocol = forwardedProto || defaultProtocol;
  if (!host) return SITE_URL;
  return `${protocol}://${host}`;
}

async function createStripeCheckoutSession(req, leadToken, leadData) {
  if (!STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY no configurada');
  const paidConfig = PAID_CLAIM_TYPES[leadData.tipo];
  if (!paidConfig) throw new Error('Tipo no soportado para pago inicial');

  const origin = getBaseUrl(req);
  const successUrl = `${origin}/?checkout=success&lead=${encodeURIComponent(leadToken)}&session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = `${origin}/?checkout=cancel&lead=${encodeURIComponent(leadToken)}`;

  const form = new URLSearchParams();
  form.append('mode', 'payment');
  form.append('success_url', successUrl);
  form.append('cancel_url', cancelUrl);
  form.append('payment_method_types[0]', 'card');
  form.append('line_items[0][quantity]', '1');
  form.append('line_items[0][price_data][currency]', 'eur');
  form.append('line_items[0][price_data][unit_amount]', String(paidConfig.grossAmountCents));
  form.append('line_items[0][price_data][product_data][name]', `LexReclama · ${leadData.tipoLabel}`);
  form.append('line_items[0][price_data][product_data][description]', `Honorarios iniciales orientativos: ${paidConfig.baseAmountLabel}`);
  form.append('metadata[leadToken]', leadToken);
  form.append('metadata[leadType]', leadData.tipo);
  form.append('metadata[leadEmail]', leadData.email);
  form.append('customer_email', leadData.email);
  form.append('locale', 'es');

  const stripeRes = await fetch(`${STRIPE_API}/checkout/sessions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
  });
  const stripeData = await stripeRes.json();
  if (!stripeRes.ok) {
    const stripeMessage = stripeData?.error?.message || `Stripe error HTTP ${stripeRes.status}`;
    throw new Error(stripeMessage);
  }
  return stripeData;
}

async function readStripeCheckoutSession(sessionId) {
  if (!STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY no configurada');
  const stripeRes = await fetch(`${STRIPE_API}/checkout/sessions/${encodeURIComponent(sessionId)}`, {
    headers: {
      'Authorization': `Bearer ${STRIPE_SECRET_KEY}`,
    },
  });
  const stripeData = await stripeRes.json();
  if (!stripeRes.ok) {
    const stripeMessage = stripeData?.error?.message || `Stripe error HTTP ${stripeRes.status}`;
    throw new Error(stripeMessage);
  }
  return stripeData;
}

function sweepPendingCheckoutLeads() {
  const now = Date.now();
  for (const [leadToken, pending] of pendingCheckoutLeads) {
    if (now - pending.createdAtMs > PENDING_CHECKOUT_TTL_MS) {
      pendingCheckoutLeads.delete(leadToken);
    }
  }
  for (const [leadToken, completed] of completedCheckoutLeads) {
    if (now - completed.completedAtMs > COMPLETED_CHECKOUT_TTL_MS) {
      completedCheckoutLeads.delete(leadToken);
    }
  }
}

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
    res.end(JSON.stringify({ error: err.message }));
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
    res.end(JSON.stringify({ error: err.message }));
  }
}

function normalizeSubscribePayload(payload) {
  const email = String(payload?.email || '').trim().toLowerCase();
  const nombre = String(payload?.nombre || '').trim();
  const tipoReclamacion = String(payload?.tipo_reclamacion || '').trim().toLowerCase();
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  if (!emailOk) return { ok: false, error: 'Email no válido' };
  if (nombre.length > 120) return { ok: false, error: 'Nombre demasiado largo' };
  if (tipoReclamacion.length > 80) return { ok: false, error: 'Tipo de reclamación demasiado largo' };
  return {
    ok: true,
    value: {
      email,
      nombre,
      tipoReclamacion,
    },
  };
}

async function subscribeContactInBrevo(payload) {
  if (!BREVO_API_KEY) throw new Error('BREVO_API_KEY no configurada');

  const attributes = {};
  if (payload.nombre) attributes.NOMBRE = payload.nombre;
  if (payload.tipoReclamacion) attributes.TIPO_RECLAMACION = payload.tipoReclamacion;

  const body = {
    email: payload.email,
    updateEnabled: true,
  };
  if (Object.keys(attributes).length > 0) body.attributes = attributes;
  if (Number.isInteger(BREVO_LIST_ID) && BREVO_LIST_ID > 0) {
    body.listIds = [BREVO_LIST_ID];
  }

  const brevoRes = await fetch(`${BREVO_API_BASE}/contacts`, {
    method: 'POST',
    headers: {
      'api-key': BREVO_API_KEY,
      'Content-Type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (brevoRes.ok) return;

  let brevoErr = {};
  try {
    brevoErr = await brevoRes.json();
  } catch {
    brevoErr = {};
  }
  const brevoMessage = String(brevoErr?.message || '').toLowerCase();
  const duplicateError = brevoRes.status === 400 && brevoMessage.includes('already exist');
  if (duplicateError) return;
  throw new Error(brevoErr?.message || `Brevo HTTP ${brevoRes.status}`);
}

async function handleSubscribe(req, res) {
  const parsed = normalizeSubscribePayload(req.parsedBody);
  if (!parsed.ok) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: parsed.error }));
    return;
  }

  try {
    await subscribeContactInBrevo(parsed.value);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
  } catch (err) {
    const message = String(err?.message || 'Error al suscribirse').toLowerCase();
    const status = message.includes('brevo_api_key no configurada') ? 503 : 502;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No se pudo completar la suscripción ahora mismo.' }));
  }
}

function normalizeCaseIdentifier(input) {
  return String(input || '').trim().toUpperCase();
}

function isCaseIdentifierValid(identifier) {
  return /^LEX-\d{1,8}$/.test(identifier);
}

function maskEmail(email) {
  const [local, domain] = String(email || '').split('@');
  if (!local || !domain) return '***';
  const safeLocal = `${local.slice(0, 2)}***`;
  return `${safeLocal}@${domain}`;
}

function parseBearerToken(req) {
  const header = String(req.headers.authorization || '').trim();
  if (!header.startsWith('Bearer ')) return '';
  return header.slice(7).trim();
}

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

function buildPortalSessionCookie(token, maxAgeSeconds) {
  const flags = [
    `${PORTAL_SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/api/portal',
    'HttpOnly',
  ];
  if (PORTAL_COOKIE_SECURE) flags.push('Secure');
  flags.push('SameSite=Strict', `Max-Age=${maxAgeSeconds}`);
  return [
    ...flags,
  ].join('; ');
}

function parsePortalSessionToken(req) {
  const cookies = parseCookies(req);
  return String(cookies[PORTAL_SESSION_COOKIE_NAME] || '').trim();
}

function sweepPortalState() {
  const now = Date.now();
  for (const [caseId, auth] of portalAuthCodes) {
    if (auth.expiresAtMs <= now || auth.used) portalAuthCodes.delete(caseId);
  }
  for (const [token, session] of portalSessions) {
    if (session.expiresAtMs <= now) portalSessions.delete(token);
  }
}

function mapIssueStatusLabel(status) {
  const labels = {
    todo: 'En revision',
    in_progress: 'En curso',
    blocked: 'Pendiente de documentacion',
    done: 'Resuelto',
  };
  return labels[status] || 'En revision';
}

function mapIssueToPortalCase(issue, messages = []) {
  const status = String(issue?.status || 'todo');
  const stepsByStatus = {
    todo: ['Recibido', 'En revision', 'Analisis legal', 'Resolucion', 'Cierre'],
    in_progress: ['Recibido', 'En revision', 'Analisis legal', 'Resolucion', 'Cierre'],
    blocked: ['Recibido', 'Pendiente de documentacion', 'Analisis legal', 'Resolucion', 'Cierre'],
    done: ['Recibido', 'Analisis legal', 'Resolucion', 'Cierre completado'],
  };
  const activeStepByStatus = {
    todo: 'En revision',
    in_progress: 'Analisis legal',
    blocked: 'Pendiente de documentacion',
    done: 'Cierre completado',
  };
  const steps = stepsByStatus[status] || stepsByStatus.todo;
  const activeStep = activeStepByStatus[status] || steps[0];
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title || 'Caso',
    status: status,
    statusLabel: mapIssueStatusLabel(status),
    updatedAt: issue.updatedAt || new Date().toISOString(),
    steps,
    activeStep,
    messages,
  };
}

async function fetchIssueByIdentifier(caseId) {
  const res = await fetch(
    `${PAPERCLIP_API}/api/companies/${COMPANY_ID}/issues?q=${encodeURIComponent(caseId)}&limit=20`,
    {
      headers: {
        Authorization: `Bearer ${SUBMIT_API_KEY}`,
      },
    },
  );
  const data = await res.json().catch(() => []);
  if (!res.ok || !Array.isArray(data)) return null;
  const exact = data.find((issue) => String(issue.identifier || '').toUpperCase() === caseId);
  return exact || null;
}

async function fetchIssueComments(issueId) {
  const res = await fetch(`${PAPERCLIP_API}/api/issues/${encodeURIComponent(issueId)}/comments`, {
    headers: {
      Authorization: `Bearer ${SUBMIT_API_KEY}`,
    },
  });
  const data = await res.json().catch(() => []);
  if (!res.ok || !Array.isArray(data)) return [];
  return data
    .filter((comment) => String(comment.body || '').trimStart().startsWith('[CLIENTE]'))
    .map((comment) => ({
      author: comment.authorAgentId ? 'Despacho' : 'Cliente',
      fromClient: !comment.authorAgentId,
      body: String(comment.body || '')
        .replace(/^\s*\[CLIENTE\]\s*/i, '')
        .replace(/^#+\s*/gm, '')
        .slice(0, 450),
    }));
}

function extractClientEmail(issue) {
  const description = String(issue?.description || '');
  const emailLine = description.match(/\*\*Email:\*\*\s*([^\s<]+)/i);
  if (emailLine && emailLine[1]) return emailLine[1].trim().toLowerCase();
  const genericMatch = description.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  if (genericMatch && genericMatch[0]) return genericMatch[0].trim().toLowerCase();
  return '';
}

async function sendPortalCodeEmail(email, caseId, code) {
  if (!BREVO_API_KEY) return false;
  const body = {
    sender: { name: 'LexReclama', email: 'no-reply@lexreclama.es' },
    to: [{ email }],
    subject: `Codigo de acceso para ${caseId}`,
    htmlContent: `<p>Tu codigo de acceso para <strong>${escapeHtml(caseId)}</strong> es:</p><p style="font-size:28px;font-weight:700;letter-spacing:4px">${escapeHtml(code)}</p><p>Caduca en 10 minutos y solo se puede usar una vez.</p>`,
  };
  const res = await fetch(`${BREVO_API_BASE}/smtp/email`, {
    method: 'POST',
    headers: {
      'api-key': BREVO_API_KEY,
      'Content-Type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  return res.ok;
}

async function handlePortalRequestCode(req, res) {
  sweepPortalState();
  const caseId = normalizeCaseIdentifier(req.parsedBody?.caseId);
  if (!isCaseIdentifierValid(caseId)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Numero de caso invalido' }));
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
    buildPortalSessionCookie(token, Math.floor(PORTAL_SESSION_TTL_MS / 1000)),
  );
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    ok: true,
    expiresAt: new Date(Date.now() + PORTAL_SESSION_TTL_MS).toISOString(),
  }));
}

function getPortalSessionFromRequest(req) {
  sweepPortalState();
  const token = parsePortalSessionToken(req);
  if (!token) return null;
  const session = portalSessions.get(token);
  if (!session) return null;
  if (session.expiresAtMs <= Date.now()) {
    portalSessions.delete(token);
    return null;
  }
  return { token, session };
}

async function handlePortalMe(req, res) {
  const auth = getPortalSessionFromRequest(req);
  if (!auth) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Sesion invalida o expirada' }));
    return;
  }
  const issueRes = await fetch(`${PAPERCLIP_API}/api/issues/${encodeURIComponent(auth.session.issueId)}`, {
    headers: {
      Authorization: `Bearer ${SUBMIT_API_KEY}`,
    },
  });
  const issue = await issueRes.json().catch(() => null);
  if (!issueRes.ok || !issue) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Caso no disponible' }));
    return;
  }

  const apiMessages = await fetchIssueComments(auth.session.issueId);
  const localMessages = portalMessages.get(auth.session.caseId) || [];
  const allMessages = [...apiMessages.slice(0, 5), ...localMessages].slice(-8);
  const portalCase = mapIssueToPortalCase(issue, allMessages.length ? allMessages : [{ author: 'Despacho', body: 'Tu caso esta en seguimiento. Te notificaremos cualquier cambio.' }]);

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
  const token = parsePortalSessionToken(req);
  if (token) portalSessions.delete(token);
  appendSetCookieHeader(res, buildPortalSessionCookie('', 0));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

async function handlePortalCaseMessage(req, res, caseIdRaw) {
  const auth = getPortalSessionFromRequest(req);
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
    await fetch(`${PAPERCLIP_API}/api/issues/${encodeURIComponent(auth.session.issueId)}/comments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SUBMIT_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        body: `## Mensaje desde portal cliente\n\nCaso: **${caseId}**\n\n${message}`,
      }),
    }).catch(() => null);
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

const PAGE_404_PATH = path.join(STATIC_DIR, '404.html');

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
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const normalizedPath = normalizePathname(url.pathname);
  const host = (req.headers.host || '').split(':')[0].toLowerCase();
  const csrfToken = getOrCreateCsrfToken(req, res);
  const nonce = generateNonce();
  // CORS only for safe read-only requests; POST endpoints are same-origin only
  if (req.method === 'GET' || req.method === 'HEAD') {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
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
      "font-src 'self' https://fonts.gstatic.com data:",
      "img-src 'self' data: https:",
      "frame-src https://js.stripe.com https://checkout.stripe.com",
      "upgrade-insecure-requests",
    ].join('; '),
  );

  if ((req.method === 'GET' || req.method === 'HEAD') && (host === SECONDARY_HOST || host === `www.${SECONDARY_HOST}`)) {
    const target = `https://${PRIMARY_HOST}${url.pathname}${url.search}`;
    res.writeHead(301, { Location: target, 'Cache-Control': 'public, max-age=3600' });
    res.end();
    return;
  }
  if ((req.method === 'GET' || req.method === 'HEAD') && BLOG_REDIRECTS[normalizedPath]) {
    const target = `${BLOG_REDIRECTS[normalizedPath]}${url.search}`;
    res.writeHead(301, { Location: target, 'Cache-Control': 'public, max-age=3600' });
    res.end();
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/portal/me') {
    await handlePortalMe(req, res);
    return;
  }

  // Lead + portal submission endpoints
  if (req.method === 'POST' && (
    url.pathname === '/submit-lead'
    || url.pathname === '/api/lead'
    || url.pathname === '/create-checkout-session'
    || url.pathname === '/confirm-checkout'
    || url.pathname === '/api/subscribe'
    || url.pathname === '/api/portal/request-code'
    || url.pathname === '/api/portal/verify-code'
    || url.pathname === '/api/portal/logout'
    || url.pathname.startsWith('/api/portal/cases/')
  )) {
    const clientIp = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const rateLimitPath = url.pathname.startsWith('/api/portal/cases/') ? '/api/portal/cases' : url.pathname;
    const rule = RATE_LIMIT_RULES[rateLimitPath];
    const rate = consumeRateLimit(rule, clientIp);
    if (rate.limited) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(rate.retryAfterSec) });
      res.end(JSON.stringify({ error: 'Demasiadas solicitudes. Inténtalo más tarde.' }));
      return;
    }
    if (!await validateCsrfToken(req, res)) return;
    if (url.pathname === '/submit-lead') { await handleSubmitLead(req, res); return; }
    if (url.pathname === '/api/lead') { await handleApiLead(req, res); return; }
    if (url.pathname === '/create-checkout-session') { await handleCreateCheckoutSession(req, res); return; }
    if (url.pathname === '/confirm-checkout') { await handleConfirmCheckout(req, res); return; }
    if (url.pathname === '/api/subscribe') { await handleSubscribe(req, res); return; }
    if (url.pathname === '/api/portal/request-code') { await handlePortalRequestCode(req, res); return; }
    if (url.pathname === '/api/portal/verify-code') { await handlePortalVerifyCode(req, res); return; }
    if (url.pathname === '/api/portal/logout') { await handlePortalLogout(req, res); return; }
    if (url.pathname.startsWith('/api/portal/cases/') && url.pathname.endsWith('/messages')) {
      const caseId = decodeURIComponent(url.pathname.replace('/api/portal/cases/', '').replace('/messages', '').replace(/\//g, ''));
      await handlePortalCaseMessage(req, res, caseId);
      return;
    }
  }
  if (req.method === 'GET' && handleLegalPage(req, res, url.pathname, nonce)) return;
  if (req.method === 'GET' && url.pathname === '/robots.txt') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
    res.end(`User-agent: *\nAllow: /\nDisallow: /admin\nSitemap: ${SITE_URL}/sitemap.xml\n`);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/sitemap.xml') {
    const sitemapHeaders = { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=300' };
    sendCompressed(req, res, sitemapHeaders, Buffer.from(buildSitemapXml()));
    return;
  }
  if (req.method === 'GET' && (normalizedPath === '/blog/' || normalizedPath in PILLAR_PAGES)) {
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
  if (req.method === 'GET' && url.pathname === '/admin') {
    await handleAdmin(req, res);
    return;
  }

  // Static file serving
  // Block internal/build directories from public access
  const BLOCKED_PREFIXES = ['/social-templates/', '/social-templates'];
  if (BLOCKED_PREFIXES.some((p) => url.pathname === p || url.pathname.startsWith(p + '/'))) {
    send404(req, res, csrfToken, nonce); return;
  }

  // Security: block dotfiles (e.g. /.env, /.gitignore) and server-side source files
  const segments = url.pathname.split('/');
  const hasDotSegment = segments.some((s) => s.startsWith('.') && s.length > 1);
  const BLOCKED_FILENAMES = new Set(['server.js', 'package.json', 'package-lock.json', 'start.sh', 'ensure-running.sh']);
  const lastSegment = segments[segments.length - 1] || '';
  if (hasDotSegment || BLOCKED_FILENAMES.has(lastSegment)) {
    send404(req, res, csrfToken, nonce); return;
  }

  let filePath = path.join(STATIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname);
  // Security: prevent path traversal
  if (!filePath.startsWith(STATIC_DIR + path.sep) && filePath !== STATIC_DIR) {
    res.writeHead(403); res.end('Forbidden'); return;
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
      if (ext === '.css' || ext === '.js') headers['Cache-Control'] = 'public, max-age=31536000, immutable';
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
});

// Periodic sweep of all in-memory Maps to prevent unbounded growth.
// Belt-and-suspenders: individual handlers also call sweep at their entry points.
setInterval(() => {
  sweepPortalState();
  sweepCsrfTokens();
  const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
  for (const [key, hits] of rateLimitMap) {
    const valid = hits.filter((t) => t > cutoff);
    if (valid.length === 0) rateLimitMap.delete(key);
    else rateLimitMap.set(key, valid);
  }
}, 30 * 60 * 1000).unref(); // .unref() so the interval doesn't keep the process alive

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Landing page: http://127.0.0.1:${PORT}`);
  console.log(`Lead submit:  POST http://127.0.0.1:${PORT}/submit-lead`);
  console.log(`Admin panel:  GET  http://127.0.0.1:${PORT}/admin (Basic Auth user: ${ADMIN_USER})`);
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
