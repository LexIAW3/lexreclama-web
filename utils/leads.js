'use strict';

/**
 * DT-3 Fase C — utilidades de leads extraídas de server.js.
 * TEST_EMAIL_BLOCKLIST y detectTestLeadReason son compartidas por
 * createNotificationService y createLeadHandlers.
 */

// Emails que se aceptan (HTTP 200) pero no se reenvían a Paperclip.
// Evita ruido en el gestor de reclamaciones durante pruebas de QA.
const TEST_EMAIL_BLOCKLIST = new Set([
  't@t.com',
  'test@test.com',
  'qa@qa.com',
  'qa@test.com',
  'test@qa.com',
]);

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

module.exports = { TEST_EMAIL_BLOCKLIST, detectTestLeadReason };
