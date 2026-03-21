/**
 * Landing page server for the despacho.
 * Serves static files and proxies lead form submissions to Paperclip.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = Number(process.env.PORT) || 8080;
const STATIC_DIR = __dirname;
const BLOG_DIR = path.join(__dirname, 'blog');
const LEGAL_TEXTS_PATH = path.join(__dirname, 'legal-texts.md');
const PAPERCLIP_API = process.env.PAPERCLIP_API_URL || 'http://127.0.0.1:3100';
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
const GESTOR_AGENT_ID = '603134d1-2f20-4c99-9bec-92547dc99b43';
const GOAL_ID = '7d4f1e3f-6909-45cd-9aed-e1cfbfb4333d';
const PRIMARY_HOST = 'lexreclama.es';
const SECONDARY_HOST = 'lexreclama.com';
const MAX_RECENT_LEADS = 25;
const recentLeads = [];
const STRIPE_API = 'https://api.stripe.com/v1';
const PENDING_CHECKOUT_TTL_MS = 6 * 60 * 60 * 1000;
const COMPLETED_CHECKOUT_TTL_MS = 24 * 60 * 60 * 1000;
const IDEMPOTENCY_WINDOW_MS = 60 * 1000;
const pendingCheckoutLeads = new Map();
const completedCheckoutLeads = new Map();
const recentLeadSubmissions = new Map();
const recentCheckoutCreations = new Map();
const idempotencyInFlight = new Map();
const BLOG_REDIRECTS = {
  '/blog/cuanto-cuesta-monitorio/': '/blog/coste-monitorio/',
  '/blog/gastos-hipotecarios/': '/blog/reclamar-gastos-hipoteca/',
};

/* ─── RATE LIMITER + CSRF ────────────────────────────────────── */
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const rateLimitMap = new Map();
const RATE_LIMIT_RULES = {
  '/submit-lead': { scope: 'submit-lead', max: 5 },
  '/create-checkout-session': { scope: 'create-checkout-session', max: 3 },
  '/confirm-checkout': { scope: 'confirm-checkout', max: 10 },
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

function validateCsrfToken(req, res) {
  return (async () => {
    const okBody = await validateAndAttachJsonBody(req, res);
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

function listBlogArticles() {
  try {
    const entries = fs.readdirSync(BLOG_DIR, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((slug) => fs.existsSync(path.join(BLOG_DIR, slug, 'index.html')))
      .sort();
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

function renderContentShell({ pageTitle, metaDescription, heading, intro, bodyHtml, canonicalPath = '/', noindex = false }) {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="description" content="${escapeHtml(metaDescription)}" />
  <link rel="canonical" href="${SITE_URL}${canonicalPath}" />
  <meta name="robots" content="${noindex ? 'noindex,follow' : 'index,follow'}" />
  <title>${escapeHtml(pageTitle)} | LexReclama</title>
  <link rel="stylesheet" href="/styles.min.css" />
  ${renderGa4Snippet()}
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

function renderGa4Snippet() {
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

  return `<!-- Google tag (gtag.js) -->
  <script async src="https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(bootstrapId)}"></script>
  <script>
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
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

function injectCsrfIntoHtml(html, token) {
  if (!token || !html.includes('name="csrfToken"')) return html;
  return html.replace(
    /(<input[^>]*name="csrfToken"[^>]*value=")[^"]*(")/g,
    `$1${token}$2`,
  );
}

function injectRuntimeSnippets(html, csrfToken = '') {
  return injectCsrfIntoHtml(injectWhatsappIntoHtml(injectGa4IntoHtml(html)), csrfToken);
}

function renderBlogIndex() {
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
  });
}

function renderPillarPage(pathname) {
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
  });
}

function buildSitemapXml() {
  const staticUrls = [
    '/',
    '/contacto/',
    '/reclamacion-deudas/',
    '/clausulas-bancarias/',
    '/clausulas-bancarias/gastos-hipotecarios/',
    '/clausulas-bancarias/clausula-suelo/',
    '/clausulas-bancarias/irph-hipoteca/',
    '/recurrir-multas/',
    '/blog/',
    '/aviso-legal',
    '/politica-privacidad',
    '/politica-cookies',
    '/condiciones',
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

function renderLegalPage(title, markdownBody) {
  const content = markdownBody || 'Contenido no disponible.';
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex, follow" />
  <title>${escapeHtml(title)} · LexReclama</title>
  ${renderGa4Snippet()}
  <style>
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f8fafc; color: #0f172a; }
    .wrap { max-width: 900px; margin: 0 auto; padding: 24px; }
    .top { margin-bottom: 16px; }
    .top a { color: #1d4ed8; text-decoration: none; font-size: 0.95rem; }
    .top a:hover { text-decoration: underline; }
    .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; }
    h1 { font-size: 1.6rem; margin: 0; padding: 20px 22px; border-bottom: 1px solid #e2e8f0; }
    pre { margin: 0; padding: 22px; white-space: pre-wrap; word-break: break-word; line-height: 1.55; font-family: ui-sans-serif, system-ui, sans-serif; font-size: 0.95rem; }
  </style>
</head>
<body>
  <main class="wrap">
    <div class="top"><a href="/">← Volver a inicio</a></div>
    <article class="card">
      <h1>${escapeHtml(title)}</h1>
      <pre>${escapeHtml(content)}</pre>
    </article>
  </main>
</body>
</html>`;
}

function handleLegalPage(req, res, pathname) {
  const page = LEGAL_PAGES[pathname];
  if (!page) return false;
  const html = renderLegalPage(page.title, page.body);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
  res.end(html);
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

async function handleSubmitLead(req, res) {
  const body = req.parsedBody;

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

  try {
    const result = await resolveIdempotentRequest({
      scope: 'submit-lead',
      key: leadData.value.idempotencyKey,
      store: recentLeadSubmissions,
      execute: async () => {
        const created = await createIssueForLead(leadData.value, { paid: false });
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
    },
  };
}

async function createIssueForLead(leadData, paymentMeta = { paid: false }) {
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

const PAGE_404_PATH = path.join(STATIC_DIR, '404.html');

function send404(res, csrfToken = '') {
  fs.readFile(PAGE_404_PATH, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(injectRuntimeSnippets(data.toString('utf8'), csrfToken));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const normalizedPath = normalizePathname(url.pathname);
  const host = (req.headers.host || '').split(':')[0].toLowerCase();
  const csrfToken = getOrCreateCsrfToken(req, res);
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
      "script-src 'self' 'unsafe-inline' https://www.googletagmanager.com https://js.stripe.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
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

  // Lead submission endpoint
  if (req.method === 'POST' && (url.pathname === '/submit-lead' || url.pathname === '/create-checkout-session' || url.pathname === '/confirm-checkout')) {
    const clientIp = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const rule = RATE_LIMIT_RULES[url.pathname];
    const rate = consumeRateLimit(rule, clientIp);
    if (rate.limited) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(rate.retryAfterSec) });
      res.end(JSON.stringify({ error: 'Demasiadas solicitudes. Inténtalo más tarde.' }));
      return;
    }
    if (!await validateCsrfToken(req, res)) return;
    if (url.pathname === '/submit-lead') { await handleSubmitLead(req, res); return; }
    if (url.pathname === '/create-checkout-session') { await handleCreateCheckoutSession(req, res); return; }
    if (url.pathname === '/confirm-checkout') { await handleConfirmCheckout(req, res); return; }
  }
  if (req.method === 'GET' && handleLegalPage(req, res, url.pathname)) return;
  if (req.method === 'GET' && url.pathname === '/robots.txt') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
    res.end(`User-agent: *\nAllow: /\nDisallow: /admin\nSitemap: ${SITE_URL}/sitemap.xml\n`);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/sitemap.xml') {
    res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
    res.end(buildSitemapXml());
    return;
  }
  if (req.method === 'GET' && (normalizedPath === '/blog/' || normalizedPath in PILLAR_PAGES)) {
    // Prefer static HTML file if it exists; fall back to generated placeholder
    const staticCandidate = path.join(STATIC_DIR, normalizedPath, 'index.html');
    try {
      const data = await fs.promises.readFile(staticCandidate, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
      res.end(injectRuntimeSnippets(data, csrfToken));
      return;
    } catch {
      // No static file found; use generated fallback below.
    }
    const html = normalizedPath === '/blog/' ? renderBlogIndex() : renderPillarPage(normalizedPath);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
    res.end(html);
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
    send404(res, csrfToken); return;
  }

  let filePath = path.join(STATIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname);
  // Security: prevent path traversal
  if (!filePath.startsWith(STATIC_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.stat(filePath, (statErr, stats) => {
    if (!statErr && stats.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        send404(res, csrfToken); return;
      }
      const ext = path.extname(filePath);
      const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
      if (ext === '.css' || ext === '.js') headers['Cache-Control'] = 'public, max-age=86400';
      res.writeHead(200, headers);
      if (ext === '.html') {
        res.end(injectRuntimeSnippets(data.toString('utf8'), csrfToken));
        return;
      }
      res.end(data);
    });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Landing page: http://127.0.0.1:${PORT}`);
  console.log(`Lead submit:  POST http://127.0.0.1:${PORT}/submit-lead`);
  console.log(`Admin panel:  GET  http://127.0.0.1:${PORT}/admin (Basic Auth user: ${ADMIN_USER})`);
  console.log(`GA4:          ${GA4_MEASUREMENT_ID || '(disabled)'}`);
  if (!ADMIN_PASSWORD) console.warn('WARN: ADMIN_PASSWORD is not set; /admin will return 503');
  console.log(`Paperclip:    ${PAPERCLIP_API}`);
});
