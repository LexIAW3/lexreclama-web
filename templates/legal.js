function renderLegalPageTemplate({
  title = '',
  bodyHtml = '<p>Contenido no disponible.</p>',
  nonce = '',
  canonicalHref = '',
  ga4SnippetHtml = '',
} = {}) {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex, follow" />
  ${canonicalHref ? `<link rel="canonical" href="${canonicalHref}" />` : ''}
  <title>${title} · LexReclama</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
  <link rel="icon" href="/favicon.svg" sizes="any" />
  <link rel="apple-touch-icon" href="/logo-avatar.png" />
  ${ga4SnippetHtml}
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
      <h1>${title}</h1>
      ${bodyHtml}
    </article>
  </main>
</body>
</html>`;
}

module.exports = {
  renderLegalPageTemplate,
};
