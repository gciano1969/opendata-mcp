/**
 * Minimal CKAN API client for dati.gov.it.
 *
 * Provides a single helper, ckanGet(), that builds the request URL,
 * enforces a timeout, and normalises errors into friendly messages.
 * Results are cached in memory with per-action TTLs to reduce upstream load.
 */

import { cacheGet, cacheSet } from "./cache.js";

const BASE_URL = "https://www.dati.gov.it/opendata/api/3/action/";
const TIMEOUT_MS = 10_000;

/** TTL in milliseconds for each CKAN action. */
const ACTION_TTL = {
  package_search: 5 * 60 * 1000,  // 5 minutes
  package_show:   15 * 60 * 1000, // 15 minutes
};
const DEFAULT_TTL = 5 * 60 * 1000;

/**
 * Call a CKAN read-only action endpoint.
 *
 * @param {string} action  CKAN action name, e.g. "package_search"
 * @param {Record<string, string | number>} params  Query parameters
 * @returns {Promise<unknown>} The `result` field of the CKAN response envelope
 * @throws {Error} With a human-readable message on timeout, HTTP error, or CKAN error
 */
export async function ckanGet(action, params = {}) {
  const url = new URL(action, BASE_URL);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }

  const cacheKey = url.toString();
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url.toString(), { signal: controller.signal });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`CKAN request timed out after ${TIMEOUT_MS / 1000} s`);
    }
    throw new Error(`Network error contacting dati.gov.it: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new Error(`CKAN returned HTTP ${response.status} for action "${action}"`);
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error("CKAN returned a non-JSON response");
  }

  if (!body.success) {
    const detail = body.error?.message ?? JSON.stringify(body.error ?? "unknown error");
    throw new Error(`CKAN error: ${detail}`);
  }

  const ttl = ACTION_TTL[action] ?? DEFAULT_TTL;
  cacheSet(cacheKey, body.result, ttl);

  return body.result;
}
