'use strict';

/**
 * DT-3 Fase E — gestor de idempotencia extraído de server.js.
 *
 * factory createIdempotencyManager({ maps, windowMs })
 *   maps    — array de Maps cuyas entradas se limpian periódicamente
 *   windowMs — ventana de tiempo en ms durante la que se cachean resultados
 *
 * Devuelve:
 *   sweepIdempotencyMaps   — limpia entradas expiradas en todos los maps
 *   resolveIdempotentRequest — ejecuta una operación una sola vez por key
 */
function createIdempotencyManager({ maps, windowMs }) {
  // idempotencyInFlight se encapsula aquí — no necesita salir al servidor.
  const idempotencyInFlight = new Map();

  function sweepIdempotencyMaps() {
    const now = Date.now();
    for (const store of maps) {
      for (const [key, entry] of store) {
        if (now - entry.createdAtMs > windowMs) {
          store.delete(key);
        }
      }
    }
  }

  async function resolveIdempotentRequest({ scope, key, store, execute }) {
    if (!key) {
      return { value: await execute(), deduplicated: false };
    }

    sweepIdempotencyMaps();
    const cached = store.get(key);
    if (cached) {
      return { value: cached.payload, deduplicated: true };
    }

    const inFlightKey = `${scope}:${key}`;
    if (idempotencyInFlight.has(inFlightKey)) {
      const value = await idempotencyInFlight.get(inFlightKey);
      return { value, deduplicated: true };
    }

    const pending = (async () => {
      const value = await execute();
      store.set(key, { createdAtMs: Date.now(), payload: value });
      return value;
    })();

    idempotencyInFlight.set(inFlightKey, pending);
    try {
      const value = await pending;
      return { value, deduplicated: false };
    } finally {
      idempotencyInFlight.delete(inFlightKey);
    }
  }

  return { sweepIdempotencyMaps, resolveIdempotentRequest };
}

module.exports = { createIdempotencyManager };
