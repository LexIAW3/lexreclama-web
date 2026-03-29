function renderBlogIndexTemplate({
  nonce = '',
  listBlogArticles,
  formatSlug,
  escapeHtml,
  renderContentShell,
} = {}) {
  const articles = typeof listBlogArticles === 'function' ? listBlogArticles() : [];
  const items = articles.length
    ? `<ul>${articles.map((slug) => `<li><a href="/blog/${slug}/">${escapeHtml(formatSlug(slug))}</a></li>`).join('')}</ul>`
    : '<p>Todavía no hay artículos publicados.</p>';

  return renderContentShell({
    pageTitle: 'Blog legal',
    metaDescription: 'Hub de contenido legal sobre reclamaciones de deudas, cláusulas bancarias y multas.',
    heading: 'Blog de reclamaciones legales',
    intro: 'Hub de contenido',
    bodyHtml: `<p>Artículos disponibles:</p>${items}`,
    canonicalPath: '/blog/',
    nonce,
  });
}

module.exports = {
  renderBlogIndexTemplate,
};
