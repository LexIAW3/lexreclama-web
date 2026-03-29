'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * Factory que crea los handlers del portal cliente.
 * Todas las dependencias se inyectan para facilitar pruebas y modularidad.
 */
function createPortalHandlers({
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
}) {
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
    const issue = await fetchIssueByIdentifier(auth.session.caseId);
    if (!issue) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Caso no disponible' }));
      return;
    }

    const issueId = String(issue.id || auth.session.issueId || '').trim();
    if (!issueId) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Caso no disponible' }));
      return;
    }

    const apiMessages = await fetchIssueComments(issueId);
    const localMessages = portalMessages.get(auth.session.caseId) || [];
    const allMessages = [...apiMessages.slice(0, 5), ...localMessages].slice(-8);
    const rawDocuments = await readIssueDocumentsIndex(issueId);
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

  return {
    handleAdminPortalTestCode,
    handlePortalRequestCode,
    handlePortalVerifyCode,
    handlePortalMe,
    handlePortalLogout,
    handlePortalCaseMessage,
    handlePortalCaseDocumentDownload,
  };
}

module.exports = { createPortalHandlers };
