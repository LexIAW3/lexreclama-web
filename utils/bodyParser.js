'use strict';

/**
 * DT-3 Fase E (body parsing) — extraído de server.js.
 * Utilidades para leer y parsear el body de las peticiones HTTP:
 *   - JSON (con límite de tamaño)
 *   - multipart/form-data con adjuntos PDF/imagen (busboy)
 */

const busboy = require('busboy');

const MAX_BODY_BYTES = 50 * 1024; // 50 KB
const MAX_UPLOAD_FILE_BYTES = 10 * 1024 * 1024; // 10 MB por fichero
const MAX_UPLOAD_FILES = 3;
const ALLOWED_UPLOAD_MIMETYPES = new Set(['application/pdf', 'image/jpeg', 'image/png']);

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

module.exports = { readBody, validateAndAttachJsonBody, parseMultipartOrJsonBody };
