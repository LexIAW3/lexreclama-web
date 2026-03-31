'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function computeFileHash(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 8);
  } catch {
    return 'dev';
  }
}

/**
 * Build asset version map for cache-busting.
 * Each entry: { attr, url, hash }
 * HTML pages reference /styles.min.css?v=HASH so browsers re-fetch on deploy
 * while caching aggressively (max-age=1y, immutable).
 *
 * @param {string} staticDir — absolute path to the web root directory
 */
function buildAssetVersions(staticDir) {
  return [
    ['href', '/styles.min.css',                path.join(staticDir, 'styles.min.css')],
    ['src',  '/app.min.js',                    path.join(staticDir, 'app.min.js')],
    ['href', '/portal-cliente/styles.min.css', path.join(staticDir, 'portal-cliente', 'styles.min.css')],
    ['src',  '/portal-cliente/app.min.js',     path.join(staticDir, 'portal-cliente', 'app.min.js')],
  ].map(([attr, url, file]) => ({ attr, url, hash: computeFileHash(file) }));
}

module.exports = { computeFileHash, buildAssetVersions };
