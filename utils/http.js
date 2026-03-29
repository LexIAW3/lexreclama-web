const zlib = require('zlib');

/**
 * Returns a fetch wrapper that aborts after `defaultTimeoutMs`.
 * Pass an explicit third arg to override per-call.
 */
function createFetchWithTimeout(defaultTimeoutMs) {
  return function fetchWithTimeout(url, options = {}, timeoutMs = defaultTimeoutMs) {
    return fetch(url, { signal: AbortSignal.timeout(timeoutMs), ...options });
  };
}

/**
 * Sends `body` (Buffer) with Brotli or gzip compression when the client
 * supports it. Falls back to uncompressed. Adds Vary: Accept-Encoding.
 */
function sendCompressed(req, res, headers, body, statusCode = 200) {
  const accept = String(req.headers['accept-encoding'] || '');
  if (accept.includes('br') && typeof zlib.brotliCompress === 'function') {
    zlib.brotliCompress(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } }, (err, compressed) => {
      if (err) { res.writeHead(statusCode, headers); res.end(body); return; }
      res.writeHead(statusCode, { ...headers, 'Content-Encoding': 'br', 'Vary': 'Accept-Encoding' });
      res.end(compressed);
    });
  } else if (accept.includes('gzip')) {
    zlib.gzip(body, { level: 6 }, (err, compressed) => {
      if (err) { res.writeHead(statusCode, headers); res.end(body); return; }
      res.writeHead(statusCode, { ...headers, 'Content-Encoding': 'gzip', 'Vary': 'Accept-Encoding' });
      res.end(compressed);
    });
  } else {
    res.writeHead(statusCode, headers);
    res.end(body);
  }
}

module.exports = {
  createFetchWithTimeout,
  sendCompressed,
};
