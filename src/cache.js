/**
 * Minimal TTL in-memory cache.
 *
 * Entries expire after their individual TTL. Stale entries are evicted lazily
 * on get() and in a periodic sweep every SWEEP_INTERVAL_MS.
 */

const SWEEP_INTERVAL_MS = 60_000; // 1 minute

/** @type {Map<string, { value: unknown, expiresAt: number }>} */
const store = new Map();

// Periodic sweep to prevent unbounded growth
const sweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (entry.expiresAt <= now) store.delete(key);
  }
}, SWEEP_INTERVAL_MS);

// Don't keep the process alive just for sweeping
sweepTimer.unref();

/**
 * Store a value under key with the given TTL.
 * @param {string} key
 * @param {unknown} value
 * @param {number} ttlMs  Time-to-live in milliseconds
 */
export function cacheSet(key, value, ttlMs) {
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
}

/**
 * Retrieve a cached value. Returns undefined if missing or expired.
 * @param {string} key
 * @returns {unknown | undefined}
 */
export function cacheGet(key) {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    store.delete(key);
    return undefined;
  }
  return entry.value;
}

/**
 * Delete a single entry. Primarily used in tests.
 * @param {string} key
 */
export function cacheDel(key) {
  store.delete(key);
}

/**
 * Clear all entries. Primarily used in tests.
 */
export function cacheClear() {
  store.clear();
}
