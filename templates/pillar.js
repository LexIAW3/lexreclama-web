function renderPillarPageTemplate({
  pathname = '',
  nonce = '',
  pillarPages = {},
  escapeHtml,
  renderContentShell,
} = {}) {
  const page = pillarPages[pathname];
  if (!page) return null;
  return renderContentShell({
    pageTitle: page.title,
    metaDescription: page.placeholder,
    heading: page.title,
    intro: page.subtitle,
    bodyHtml: `<p>${escapeHtml(page.placeholder)}</p>`,
    canonicalPath: pathname,
    noindex: true,
    nonce,
  });
}

module.exports = {
  renderPillarPageTemplate,
};
