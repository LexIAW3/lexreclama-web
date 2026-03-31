'use strict';

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

module.exports = { RATE_LIMIT_WINDOW_MS, RATE_LIMIT_RULES };
