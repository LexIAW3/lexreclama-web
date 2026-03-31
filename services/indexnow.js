'use strict';

/**
 * DT-3 Fase E — servicio IndexNow extraído de server.js.
 * Permite notificar a los motores de búsqueda URLs actualizadas.
 */

/**
 * @param {object} deps
 * @param {string}   deps.indexNowKey       — clave IndexNow (env INDEXNOW_KEY)
 * @param {string}   deps.siteUrl           — URL base del sitio (https://www.lexreclama.es)
 * @param {string}   deps.indexNowEndpoint  — endpoint de IndexNow
 * @param {Function} deps.fetchWithTimeout
 */
function createIndexNowService({ indexNowKey, siteUrl, indexNowEndpoint, fetchWithTimeout }) {
  function normalizeIndexNowUrl(input) {
    const value = String(input || '').trim();
    if (!value) return null;
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== 'https:' || parsed.host !== 'www.lexreclama.es') return null;
      parsed.hash = '';
      return parsed.toString();
    } catch {
      return null;
    }
  }

  async function submitIndexNow(urls) {
    if (!indexNowKey) {
      return { ok: false, status: 503, error: 'INDEXNOW_KEY no configurada' };
    }
    const uniqueUrls = [...new Set(urls.map(normalizeIndexNowUrl).filter(Boolean))].slice(0, 10000);
    if (!uniqueUrls.length) {
      return { ok: false, status: 400, error: 'No hay URLs válidas para IndexNow' };
    }
    const payload = {
      host: 'www.lexreclama.es',
      key: indexNowKey,
      keyLocation: `${siteUrl}/${indexNowKey}.txt`,
      urlList: uniqueUrls,
    };
    const response = await fetchWithTimeout(indexNowEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
    });
    const bodyText = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: 'IndexNow rechazó la solicitud',
        detail: bodyText.slice(0, 500),
      };
    }
    return { ok: true, status: response.status, submitted: uniqueUrls.length, responseText: bodyText.slice(0, 500) };
  }

  return { normalizeIndexNowUrl, submitIndexNow };
}

module.exports = { createIndexNowService };
