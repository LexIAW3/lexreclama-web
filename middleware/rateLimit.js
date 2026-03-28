function createRateLimiter({ defaultWindowMs }) {
  const store = new Map();

  function consumeRateLimit(rule, ip) {
    if (!rule) {
      console.error('[rate-limit] consumeRateLimit called with undefined rule - no limit applied');
      return { limited: false, retryAfterSec: 0 };
    }
    const now = Date.now();
    const windowMs = Number.isFinite(rule?.windowMs) && rule.windowMs > 0
      ? rule.windowMs
      : defaultWindowMs;
    const windowStart = now - windowMs;
    const key = `${rule.scope}:${ip || 'unknown'}`;
    const current = store.get(key) || [];
    const validHits = current.filter((timestamp) => timestamp > windowStart);
    if (validHits.length >= rule.max) {
      const oldest = validHits[0];
      const retryAfterSec = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
      store.set(key, validHits);
      return { limited: true, retryAfterSec };
    }
    validHits.push(now);
    store.set(key, validHits);
    return { limited: false, retryAfterSec: 0 };
  }

  function sweepRateLimitEntries() {
    const cutoff = Date.now() - defaultWindowMs;
    for (const [key, hits] of store) {
      const valid = hits.filter((t) => t > cutoff);
      if (valid.length === 0) store.delete(key);
      else store.set(key, valid);
    }
  }

  return {
    consumeRateLimit,
    sweepRateLimitEntries,
  };
}

module.exports = {
  createRateLimiter,
};
