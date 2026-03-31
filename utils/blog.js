'use strict';

/**
 * DT-3 Fase E — utilidades de blog extraídas de server.js.
 * listBlogArticles: lee el directorio blog/ con caché en memoria (TTL 60s).
 * formatSlug: convierte un slug kebab-case en título capitalizado.
 */

const BLOG_ARTICLES_CACHE_TTL_MS = 60 * 1000; // 60 s

/**
 * @param {object} deps
 * @param {object}   deps.fs
 * @param {object}   deps.path
 * @param {string}   deps.blogDir — ruta absoluta al directorio blog/
 */
function createBlogUtils({ fs, path, blogDir }) {
  let blogArticlesCache = null;
  let blogArticlesCachedAtMs = 0;

  function listBlogArticles() {
    const now = Date.now();
    if (blogArticlesCache && now - blogArticlesCachedAtMs < BLOG_ARTICLES_CACHE_TTL_MS) {
      return blogArticlesCache;
    }
    try {
      const entries = fs.readdirSync(blogDir, { withFileTypes: true });
      const result = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((slug) => fs.existsSync(path.join(blogDir, slug, 'index.html')))
        .sort();
      blogArticlesCache = result;
      blogArticlesCachedAtMs = now;
      return result;
    } catch {
      return [];
    }
  }

  return { listBlogArticles };
}

function formatSlug(slug) {
  return slug
    .split('-')
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(' ');
}

module.exports = { createBlogUtils, formatSlug };
