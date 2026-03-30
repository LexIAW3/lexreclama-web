'use strict';

/**
 * DT-3 Fase D — bloque de rendering extraído de server.js.
 *
 * Factory `createRenderer` recibe todas las dependencias por DI y devuelve
 * las funciones de rendering y de inyección de snippets en HTML.
 * Las funciones puras (sectionSlice, formatDate, etc.) se exportan
 * directamente además de devolverse desde la factory.
 */

// ---------------------------------------------------------------------------
// Pure utilities (no dependencies)
// ---------------------------------------------------------------------------

function sectionSlice(fullText, startMarker, endMarker) {
  const start = fullText.indexOf(startMarker);
  if (start === -1) return '';
  const end = endMarker ? fullText.indexOf(endMarker, start + startMarker.length) : -1;
  const out = end === -1 ? fullText.slice(start) : fullText.slice(start, end);
  return out.replaceAll('\\[', '[').replaceAll('\\]', ']').trim();
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

function normalizeWhatsappNumber(raw) {
  const cleaned = String(raw || '').replace(/[^\d]/g, '');
  return cleaned || '';
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

// ---------------------------------------------------------------------------
// Markdown renderer (needs escapeHtml)
// ---------------------------------------------------------------------------

function createMarkdownToHtml(escapeHtml) {
  return function markdownToHtml(text) {
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
  };
}

// ---------------------------------------------------------------------------
// Main factory
// ---------------------------------------------------------------------------

/**
 * @param {object} deps
 * @param {string}   deps.siteUrl
 * @param {string}   deps.assetCssHash
 * @param {Array}    deps.assetVersions          — [{attr, url, hash}]
 * @param {string}   deps.ga4MeasurementId
 * @param {string}   deps.googleAdsId
 * @param {string}   deps.googleAdsConversionLabel
 * @param {string}   deps.whatsappNumber
 * @param {number}   deps.maxRecentLeads
 * @param {string}   deps.legalTextsPath
 * @param {string}   deps.page404Path
 * @param {object}   deps.pillarPages
 * @param {Array}    deps.recentLeads            — live mutable reference
 * @param {Function} deps.escapeHtml
 * @param {Function} deps.sendCompressed
 * @param {object}   deps.fs
 * @param {Function} deps.renderBlogIndexTemplate
 * @param {Function} deps.renderPillarPageTemplate
 * @param {Function} deps.renderAdminPageTemplate
 * @param {Function} deps.renderLegalPageTemplate
 * @param {Function} deps.listBlogArticles
 * @param {Function} deps.formatSlug
 */
function createRenderer({
  siteUrl,
  assetCssHash,
  assetVersions,
  ga4MeasurementId,
  googleAdsId,
  googleAdsConversionLabel,
  whatsappNumber,
  maxRecentLeads,
  legalTextsPath,
  page404Path,
  pillarPages,
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
}) {
  const markdownToHtml = createMarkdownToHtml(escapeHtml);

  // -- GA4 ------------------------------------------------------------------

  function renderGa4Snippet(nonce = '') {
    const trackingIds = [ga4MeasurementId, googleAdsId].filter(Boolean);
    if (!trackingIds.length) return '';

    const bootstrapId = trackingIds[0];
    const configLines = trackingIds.map((id) => `    gtag("config", "${escapeHtml(id)}");`).join('\n');
    const adsSendTo = googleAdsId && googleAdsConversionLabel
      ? `${googleAdsId}/${googleAdsConversionLabel}`
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
    if (!ga4MeasurementId && !googleAdsId) {
      return html.replace('<!-- GA4_SNIPPET -->', '');
    }
    const snippet = renderGa4Snippet();
    if (html.includes('<!-- GA4_SNIPPET -->')) {
      return html.replace('<!-- GA4_SNIPPET -->', snippet);
    }
    return html.replace('</head>', `${snippet}\n</head>`);
  }

  // -- WhatsApp -------------------------------------------------------------

  function buildWhatsappHref() {
    const number = normalizeWhatsappNumber(whatsappNumber);
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

  // -- Asset versions -------------------------------------------------------

  function injectAssetVersionsIntoHtml(html) {
    let result = html;
    for (const { attr, url, hash } of assetVersions) {
      result = result.replace(
        new RegExp(`${attr}="(${url.replace(/[.]/g, '\\.')})"`, 'g'),
        `${attr}="$1?v=${hash}"`,
      );
    }
    return result;
  }

  // -- Runtime snippet injection --------------------------------------------

  function injectRuntimeSnippets(html, csrfToken = '', nonce = '') {
    let result = injectCsrfIntoHtml(injectWhatsappIntoHtml(injectGa4IntoHtml(injectAssetVersionsIntoHtml(html))), csrfToken);
    if (nonce) result = injectNonceIntoHtml(result, nonce);
    return result;
  }

  // -- Content shell --------------------------------------------------------

  function renderContentShell({ pageTitle, metaDescription, heading, intro, bodyHtml, canonicalPath = '/', noindex = false, nonce = '' }) {
    return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="description" content="${escapeHtml(metaDescription)}" />
  <link rel="canonical" href="${siteUrl}${canonicalPath}" />
  <meta name="robots" content="${noindex ? 'noindex,follow' : 'index,follow'}" />
  <title>${escapeHtml(pageTitle)} | LexReclama</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
  <link rel="icon" href="/favicon.svg" sizes="any" />
  <link rel="apple-touch-icon" href="/logo-avatar.png" />
  <link rel="stylesheet" href="/styles.min.css?v=${assetCssHash}" />
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

  // -- Blog / Pillar pages --------------------------------------------------

  function renderBlogIndex(nonce = '') {
    return renderBlogIndexTemplate({
      nonce,
      listBlogArticles,
      formatSlug,
      escapeHtml,
      renderContentShell,
    });
  }

  function renderPillarPage(pathname, nonce = '') {
    return renderPillarPageTemplate({
      pathname,
      nonce,
      pillarPages,
      escapeHtml,
      renderContentShell,
    });
  }

  // -- Legal pages ----------------------------------------------------------

  function readLegalTexts() {
    try {
      return fs.readFileSync(legalTextsPath, 'utf8');
    } catch (err) {
      console.warn(`WARN: could not read legal texts file at ${legalTextsPath}: ${err.message}`);
      return '';
    }
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

  function renderLegalPage(title, markdownBody, nonce = '', canonicalPath = '') {
    const bodyHtml = markdownToHtml(markdownBody) || '<p>Contenido no disponible.</p>';
    return renderLegalPageTemplate({
      title: escapeHtml(title),
      bodyHtml,
      nonce,
      canonicalHref: canonicalPath ? `${siteUrl}${canonicalPath}` : '',
      ga4SnippetHtml: renderGa4Snippet(nonce),
    });
  }

  function handleLegalPage(req, res, pathname, nonce = '') {
    const page = LEGAL_PAGES[pathname];
    if (!page) return false;
    const html = renderLegalPage(page.title, page.body, nonce, pathname);
    sendCompressed(req, res, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' }, Buffer.from(html));
    return true;
  }

  // -- Admin page -----------------------------------------------------------

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
    return renderAdminPageTemplate({
      nonce,
      rowsHtml: rows || '<tr><td class="empty" colspan="6">Sin leads todavía.</td></tr>',
      maxRecentLeads,
    });
  }

  // -- 404 ------------------------------------------------------------------

  function send404(req, res, csrfToken = '', nonce = '') {
    fs.readFile(page404Path, (err, data) => {
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

  return {
    markdownToHtml,
    renderGa4Snippet,
    injectGa4IntoHtml,
    renderWhatsappButtonHtml,
    injectWhatsappIntoHtml,
    injectNonceIntoHtml,
    injectCsrfIntoHtml,
    injectAssetVersionsIntoHtml,
    injectRuntimeSnippets,
    renderContentShell,
    renderBlogIndex,
    renderPillarPage,
    renderLegalPage,
    handleLegalPage,
    renderAdminPage,
    send404,
  };
}

module.exports = { createRenderer, sectionSlice, formatDate, normalizeWhatsappNumber, injectNonceIntoHtml, injectCsrfIntoHtml };
