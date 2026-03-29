const path = require('path');

async function routeStaticFiles({
  req,
  res,
  url,
  fs,
  staticDir,
  blockedPrefixes,
  blockedFilenames,
  mime,
  compressibleExts,
  send404,
  injectRuntimeSnippets,
  sendCompressed,
  csrfToken,
  nonce,
}) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, {
      'Content-Type': 'text/plain; charset=utf-8',
      Allow: 'GET, HEAD',
    });
    res.end('Method Not Allowed');
    return true;
  }

  if (blockedPrefixes.some((p) => url.pathname === p || url.pathname.startsWith(p + '/'))) {
    send404(req, res, csrfToken, nonce);
    return true;
  }

  const segments = url.pathname.split('/');
  const hasDotSegment = segments.some((s) => s.startsWith('.') && s.length > 1);
  const lastSegment = segments[segments.length - 1] || '';
  const hasBlockedExtension = lastSegment.endsWith('.md')
    || lastSegment.endsWith('.log')
    || lastSegment.endsWith('.conf')
    || lastSegment.endsWith('.sh')
    || lastSegment.endsWith('.php')
    || lastSegment.endsWith('.asp')
    || lastSegment.endsWith('.aspx')
    || lastSegment.endsWith('.jsp');
  if (hasDotSegment || blockedFilenames.has(lastSegment) || hasBlockedExtension) {
    send404(req, res, csrfToken, nonce);
    return true;
  }

  let filePath = path.join(staticDir, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!filePath.startsWith(staticDir + path.sep) && filePath !== staticDir) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return true;
  }

  try {
    const stats = await fs.promises.stat(filePath);
    if (stats.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
  } catch {
    // Keep original filePath and let readFile decide 404.
  }

  try {
    const data = await fs.promises.readFile(filePath);
    const ext = path.extname(filePath);
    const headers = { 'Content-Type': mime[ext] || 'application/octet-stream' };
    if (ext === '.css' || ext === '.js') {
      headers['Cache-Control'] = 'public, max-age=31536000, immutable';
    } else if (ext && ext !== '.html') {
      headers['Cache-Control'] = 'public, max-age=86400';
    }

    if (ext === '.html') {
      const body = Buffer.from(injectRuntimeSnippets(data.toString('utf8'), csrfToken, nonce));
      sendCompressed(req, res, headers, body);
      return true;
    }
    if (compressibleExts.has(ext)) {
      sendCompressed(req, res, headers, data);
      return true;
    }
    res.writeHead(200, headers);
    res.end(data);
    return true;
  } catch {
    send404(req, res, csrfToken, nonce);
    return true;
  }
}

module.exports = {
  routeStaticFiles,
};
