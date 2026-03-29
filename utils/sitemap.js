const DEFAULT_SITEMAP_CACHE_TTL_MS = 5 * 60 * 1000;

function createSitemapBuilder({
  siteUrl,
  staticDir,
  listBlogArticles,
  blogRedirects,
  fsModule,
  pathModule,
  cacheTtlMs = DEFAULT_SITEMAP_CACHE_TTL_MS,
} = {}) {
  let sitemapCache = null;
  let sitemapCachedAtMs = 0;

  function buildSitemapXmlUncached() {
    const staticUrls = [
      '/',
      '/contacto/',
      '/reclamacion-deudas/',
      '/clausulas-bancarias/',
      '/clausulas-bancarias/gastos-hipotecarios/',
      '/clausulas-bancarias/clausula-suelo/',
      '/clausulas-bancarias/irph-hipoteca/',
      '/recurrir-multas/',
      '/multas-dgt/',
      '/blog/',
    ];
    const blogUrls = listBlogArticles()
      .map((slug) => `/blog/${slug}/`)
      .filter((urlPath) => !blogRedirects[urlPath]);
    const urls = [...staticUrls, ...blogUrls];

    function urlLastMod(urlPath) {
      const filePath = urlPath === '/'
        ? pathModule.join(staticDir, 'index.html')
        : pathModule.join(staticDir, urlPath.replace(/^\//, ''), 'index.html');
      try {
        const mtime = fsModule.statSync(filePath).mtime;
        return mtime.toISOString().slice(0, 10);
      } catch {
        return new Date().toISOString().slice(0, 10);
      }
    }

    const body = urls
      .map((urlPath) => `  <url><loc>${siteUrl}${urlPath}</loc><lastmod>${urlLastMod(urlPath)}</lastmod></url>`)
      .join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
  }

  return function buildSitemapXml() {
    const now = Date.now();
    if (sitemapCache && now - sitemapCachedAtMs < cacheTtlMs) {
      return sitemapCache;
    }
    sitemapCache = buildSitemapXmlUncached();
    sitemapCachedAtMs = now;
    return sitemapCache;
  };
}

module.exports = {
  createSitemapBuilder,
};
