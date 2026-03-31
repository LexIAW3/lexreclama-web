'use strict';

/**
 * Application bootstrap — loads env config and wires all services / handlers.
 * Exports a flat object consumed by server.js.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const { safeEqual } = require('./utils/crypto');
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
const { buildAssetVersions } = require('./utils/assets');
const { detectTestLeadReason } = require('./utils/leads');
const { createIdempotencyManager } = require('./utils/idempotency');
const { createBlogUtils, formatSlug } = require('./utils/blog');
const { validateAndAttachJsonBody, parseMultipartOrJsonBody } = require('./utils/bodyParser');
const { renderAdminPageTemplate } = require('./templates/admin');
const { renderBlogIndexTemplate } = require('./templates/blog');
const { renderLegalPageTemplate } = require('./templates/legal');
const { renderPillarPageTemplate } = require('./templates/pillar');
const { parseCookies, createCsrfManager } = require('./middleware/csrf');
const { createRateLimiter } = require('./middleware/rateLimit');
const { extractClientEmail, createNotificationService } = require('./services/notifications');
const { createStripeService } = require('./services/stripe');
const { createPaperclipService } = require('./services/paperclip');
const { createRenderer } = require('./services/renderer');
const { createIndexNowService } = require('./services/indexnow');
const { createPortalHandlers } = require('./handlers/portal');
const { createLeadHandlers } = require('./handlers/leads');
const { createCheckoutHandlers } = require('./handlers/checkout');
const { createAdminHandlers } = require('./handlers/admin');
const { RATE_LIMIT_WINDOW_MS } = require('./config/rateLimitRules');
const { PILLAR_PAGES } = require('./config/pillarPages');

// ── Config ────────────────────────────────────────────────────────────
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
  .split(',').map((e) => e.trim()).filter(Boolean);
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
const STRIPE_API = 'https://api.stripe.com/v1';
const COMPRESSIBLE_EXTS = new Set(['.html', '.css', '.js', '.json', '.xml', '.txt', '.svg']);
const BLOG_REDIRECTS = {
  '/blog/cuanto-cuesta-monitorio/': '/blog/coste-monitorio/',
  '/blog/gastos-hipotecarios/': '/blog/reclamar-gastos-hipoteca/',
};
const BLOCKED_PREFIXES = [
  '/social-templates/', '/social-templates',
  '/utils/', '/utils',
  '/middleware/', '/middleware',
  '/routes/', '/routes',
  '/services/', '/services',
  '/templates/', '/templates',
  '/handlers/', '/handlers',
  '/config/', '/config',
  '/node_modules/', '/node_modules',
];
const BLOCKED_FILENAMES = new Set([
  'server.js', 'bootstrap.js', 'package.json', 'package-lock.json',
  'start.sh', 'ensure-running.sh', 'legal-texts.md', 'logo-preview.html', 'design-system.html',
]);

// ── In-memory state ───────────────────────────────────────────────────
const recentLeads = [];
const pendingCheckoutLeads = new Map();
const completedCheckoutLeads = new Map();
const recentLeadSubmissions = new Map();
const recentCheckoutCreations = new Map();
const portalAuthCodes = new Map();
const portalSessions = new Map();
const portalMessages = new Map();

// ── Fetch ─────────────────────────────────────────────────────────────
const FETCH_TIMEOUT_API_MS = 10 * 1000;
const FETCH_TIMEOUT_EXT_MS = 8 * 1000;
const FETCH_TIMEOUT_OCR_MS = 30 * 1000;
const fetchWithTimeout = createFetchWithTimeout(FETCH_TIMEOUT_EXT_MS);

// ── Assets ────────────────────────────────────────────────────────────
const ASSET_VERSIONS = buildAssetVersions(STATIC_DIR);
const ASSET_CSS_HASH = ASSET_VERSIONS[0].hash;

// ── Portal helpers ────────────────────────────────────────────────────
const PORTAL_CODE_TTL_MS = 10 * 60 * 1000;
const PORTAL_SESSION_TTL_MS = 4 * 60 * 60 * 1000;
const PORTAL_SESSION_COOKIE_NAME = 'lex_portal_session';
const PORTAL_COOKIE_SECURE =
  process.env.NODE_ENV === 'production'
  || String(process.env.HTTPS_ENABLED || '').trim().toLowerCase() === 'true';

const runPortalStateSweep = () => sweepPortalState({ portalAuthCodes, portalSessions });
const parsePortalSessionTokenFromRequest = (req) =>
  parsePortalSessionToken(req, { cookieName: PORTAL_SESSION_COOKIE_NAME, parseCookies });
const buildPortalSessionCookieHeader = (token, maxAgeSeconds) =>
  buildPortalSessionCookie(token, maxAgeSeconds, { cookieName: PORTAL_SESSION_COOKIE_NAME, secure: PORTAL_COOKIE_SECURE });
const getPortalSession = (req) =>
  getPortalSessionFromRequest(req, { portalSessions, sweepPortalState: runPortalStateSweep, parsePortalSessionTokenFromRequest });

// ── Services ──────────────────────────────────────────────────────────
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

// ── CSRF + Rate Limiter + Idempotency ─────────────────────────────────
const {
  sweepCsrfTokens,
  getOrCreateCsrfToken,
  validateCsrfToken,
} = createCsrfManager({
  cookieName: 'lex_csrf_token',
  ttlMs: 12 * 60 * 60 * 1000,
  randomToken: () => crypto.randomBytes(32).toString('hex'),
  safeEqual,
  parseBody: parseMultipartOrJsonBody,
});

const { consumeRateLimit, sweepRateLimitEntries } = createRateLimiter({ defaultWindowMs: RATE_LIMIT_WINDOW_MS });

const { resolveIdempotentRequest } = createIdempotencyManager({
  maps: [recentLeadSubmissions, recentCheckoutCreations],
  windowMs: 60 * 1000,
});

// ── Handlers ──────────────────────────────────────────────────────────
const {
  handleAdminPortalTestCode,
  handlePortalRequestCode,
  handlePortalVerifyCode,
  handlePortalMe,
  handlePortalLogout,
  handlePortalCaseMessage,
  handlePortalCaseDocumentDownload,
} = createPortalHandlers({
  portalAuthCodes, portalSessions, portalMessages,
  runPortalStateSweep, parsePortalSessionTokenFromRequest,
  buildPortalSessionCookieHeader, getPortalSession,
  PORTAL_CODE_TTL_MS, PORTAL_SESSION_TTL_MS,
  DOCUMENTS_DIR, SUBMIT_API_KEY, PAPERCLIP_API, FETCH_TIMEOUT_API_MS,
  fetchIssueByIdentifier, fetchIssueComments, sendPortalCodeEmail, fetchWithTimeout,
  extractClientEmail, appendSetCookieHeader,
  normalizeCaseIdentifier, isCaseIdentifierValid, maskEmail, mapIssueToPortalCase,
});

const PAID_CLAIM_TYPES = {
  deuda: { label: 'Reclamación de deuda impagada', grossAmountCents: 5929, baseAmountLabel: '49 EUR + IVA' },
  multa: { label: 'Impugnación de multa', grossAmountCents: 4719, baseAmountLabel: '39 EUR + IVA' },
};

const {
  requiresUpfrontPayment,
  normalizeLeadPayload,
  handleSubmitLead,
  handleApiLead,
  handleSubscribe,
} = createLeadHandlers({
  createIssueForLead, uploadDocumentToOcr, resolveIdempotentRequest,
  recentLeadSubmissions, subscribeContactInBrevo, sendLeadMagnetEmail,
  maskEmail, detectTestLeadReason,
  paidClaimTypes: PAID_CLAIM_TYPES,
  leadMagnetPdfPath: LEAD_MAGNET_PDF_PATH,
  privacyPolicyVersion: PRIVACY_POLICY_VERSION,
});

const { listBlogArticles } = createBlogUtils({ fs, path, blogDir: BLOG_DIR });

const buildSitemapXml = createSitemapBuilder({
  siteUrl: SITE_URL, staticDir: STATIC_DIR, listBlogArticles,
  blogRedirects: BLOG_REDIRECTS, fsModule: fs, pathModule: path,
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
  siteUrl: SITE_URL, assetCssHash: ASSET_CSS_HASH, assetVersions: ASSET_VERSIONS,
  ga4MeasurementId: GA4_MEASUREMENT_ID, googleAdsId: GOOGLE_ADS_ID,
  googleAdsConversionLabel: GOOGLE_ADS_CONVERSION_LABEL,
  whatsappNumber: WHATSAPP_NUMBER, maxRecentLeads: MAX_RECENT_LEADS,
  legalTextsPath: LEGAL_TEXTS_PATH, page404Path: PAGE_404_PATH,
  pillarPages: PILLAR_PAGES, recentLeads, escapeHtml, sendCompressed, fs,
  renderBlogIndexTemplate, renderPillarPageTemplate,
  renderAdminPageTemplate, renderLegalPageTemplate,
  listBlogArticles, formatSlug,
});

const { submitIndexNow, normalizeIndexNowUrl } = createIndexNowService({
  indexNowKey: INDEXNOW_KEY, siteUrl: SITE_URL,
  indexNowEndpoint: INDEXNOW_ENDPOINT, fetchWithTimeout,
});

const { handleAdmin, logAdminAudit } = createAdminHandlers({
  getClientIp, adminPassword: ADMIN_PASSWORD, adminUser: ADMIN_USER,
  isAdminAuthorized, safeEqual, sendAdminAuthChallenge, renderAdminPage,
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
  stripeSecretKey: STRIPE_SECRET_KEY, stripeApi: STRIPE_API,
  fetchWithTimeout, paidClaimTypes: PAID_CLAIM_TYPES,
  getBaseUrl, pendingCheckoutLeads, completedCheckoutLeads,
  pendingCheckoutTtlMs: 6 * 60 * 60 * 1000,
  completedCheckoutTtlMs: 24 * 60 * 60 * 1000,
});

const { handleCreateCheckoutSession, handleConfirmCheckout } = createCheckoutHandlers({
  normalizeLeadPayload, requiresUpfrontPayment, resolveIdempotentRequest,
  recentCheckoutCreations, pendingCheckoutLeads, completedCheckoutLeads,
  createStripeCheckoutSession, readStripeCheckoutSession, sweepPendingCheckoutLeads,
  createIssueForLead, paidClaimTypes: PAID_CLAIM_TYPES,
});

// ── Periodic sweep ────────────────────────────────────────────────────
function sweepAllMaps() {
  runPortalStateSweep();
  sweepCsrfTokens();
  const activeCaseIds = new Set([...portalSessions.values()].map((s) => s.caseId));
  for (const caseId of portalMessages.keys()) {
    if (!activeCaseIds.has(caseId)) portalMessages.delete(caseId);
  }
  sweepRateLimitEntries();
}

// ── Exports ───────────────────────────────────────────────────────────
module.exports = {
  PORT, STATIC_DIR, SITE_URL, PRIMARY_HOST, SECONDARY_HOST, APP_HOST,
  INDEXNOW_KEY, INDEXNOW_REINDEX_TOKEN, BLOG_REDIRECTS, COMPRESSIBLE_EXTS,
  BLOCKED_PREFIXES, BLOCKED_FILENAMES,
  ADMIN_ALLOWED_IPS, GA4_MEASUREMENT_ID, ADMIN_USER, ADMIN_PASSWORD, PAPERCLIP_API, OCR_SERVER,
  fetchWithTimeout, sendCompressed, validateAndAttachJsonBody,
  getOrCreateCsrfToken, validateCsrfToken, consumeRateLimit,
  injectRuntimeSnippets, renderBlogIndex, renderPillarPage, handleLegalPage, send404,
  submitIndexNow, normalizeIndexNowUrl, buildSitemapXml,
  isAdminIpAllowed, isAdminAuthorized, safeEqual, sendAdminAuthChallenge,
  logAdminAudit, handleAdmin,
  handleCreateCheckoutSession, handleConfirmCheckout,
  handleSubmitLead, handleApiLead, handleSubscribe,
  handleAdminPortalTestCode, handlePortalRequestCode, handlePortalVerifyCode,
  handlePortalMe, handlePortalLogout, handlePortalCaseMessage, handlePortalCaseDocumentDownload,
  sweepAllMaps,
};
