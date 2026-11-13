/**
 * preview_csv tool implementation.  Results are cached for 15 minutes keyed
 * on (resource_url, rows) to avoid redundant downloads.
 *
 * Downloads the first rows of a CSV resource and returns them as formatted
 * text. Enforces a 5 MB download cap (stream-and-abort), validates that the
 * resource is actually CSV, and refuses localhost / private-IP URLs.
 *
 * Security:
 *   - Rejects non-http/https schemes.
 *   - Resolves the hostname with dns.lookup (all addresses) and rejects any
 *     address that is loopback, private (RFC 1918), link-local, or 0.0.0.0/8.
 *     This prevents DNS rebinding attacks.
 *   - Follows redirects manually (redirect: "manual"), re-validating each
 *     redirect target, with a maximum of 3 hops.
 *
 * CSV parsing is RFC 4180-compliant:
 *   - Strips a leading UTF-8 BOM (\uFEFF) if present.
 *   - Auto-detects the delimiter (comma, semicolon, or tab) from the first line.
 *   - Handles double-quoted fields including embedded delimiters and newlines.
 */

import dns from "node:dns/promises";
import { cacheGet, cacheSet } from "../cache.js";

const SIZE_LIMIT = 5 * 1024 * 1024; // 5 MB
const DOWNLOAD_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

// ---------------------------------------------------------------------------
// IP address classification
// ---------------------------------------------------------------------------

/**
 * Return true if the IPv4 address string falls in a blocked range:
 * loopback (127.0.0.0/8), private RFC-1918, link-local (169.254.0.0/16),
 * or unspecified (0.0.0.0/8).
 * @param {string} addr
 */
function isBlockedIPv4(addr) {
  const parts = addr.split(".");
  if (parts.length !== 4) return false;
  const [a, b] = parts.map(Number);
  return (
    a === 0 || // 0.0.0.0/8 unspecified
    a === 127 || // 127.0.0.0/8 loopback
    a === 10 || // 10.0.0.0/8 private
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12 private
    (a === 192 && b === 168) || // 192.168.0.0/16 private
    (a === 169 && b === 254) // 169.254.0.0/16 link-local
  );
}

/**
 * Return true if the IPv6 address string falls in a blocked range:
 * loopback (::1), link-local (fe80::/10), or unique-local (fc00::/7).
 * @param {string} addr
 */
function isBlockedIPv6(addr) {
  const lower = addr.toLowerCase().replace(/^\[|\]$/g, "");
  if (lower === "::1") return true;
  // link-local: fe80::/10  (fe80 – febf)
  if (/^fe[89ab][0-9a-f]:/i.test(lower)) return true;
  // unique-local: fc00::/7  (fc00 – fdff)
  if (/^f[cd][0-9a-f]{2}:/i.test(lower)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// URL security guard (synchronous — scheme and literal-IP checks)
// ---------------------------------------------------------------------------

/** @param {string} rawUrl */
function assertSafeUrlSync(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: "${rawUrl}"`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Refusing non-http/https URL scheme "${parsed.protocol}". Only http and https are allowed.`
    );
  }

  const host = parsed.hostname.toLowerCase();

  if (host === "localhost") {
    throw new Error("Refusing request to localhost.");
  }

  // If the host is already a literal IP address, check it immediately.
  if (isBlockedIPv4(host)) {
    throw new Error(`Refusing request to private/loopback IP address "${host}".`);
  }
  if (isBlockedIPv6(host)) {
    throw new Error(`Refusing request to private/loopback IPv6 address "${host}".`);
  }
}

// ---------------------------------------------------------------------------
// DNS-resolution security guard (async — catches DNS rebinding)
// ---------------------------------------------------------------------------

/**
 * Resolve all addresses for hostname and throw if any is in a blocked range.
 * @param {string} hostname
 */
async function assertSafeDns(hostname) {
  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch (err) {
    throw new Error(`DNS lookup failed for "${hostname}": ${err.message}`);
  }

  for (const { address, family } of addresses) {
    if (family === 4 && isBlockedIPv4(address)) {
      throw new Error(
        `Refusing request: hostname "${hostname}" resolves to private/loopback address ${address}.`
      );
    }
    if (family === 6 && isBlockedIPv6(address)) {
      throw new Error(
        `Refusing request: hostname "${hostname}" resolves to private/loopback IPv6 address ${address}.`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Redirect-following fetch with per-hop re-validation
// ---------------------------------------------------------------------------

/**
 * Fetch a URL following up to MAX_REDIRECTS redirects, re-validating the
 * hostname of each redirect target against the security rules.
 *
 * @param {string} url
 * @param {AbortSignal} signal
 * @returns {Promise<Response>} The final non-redirect response
 */
async function safeFetch(url, signal) {
  let currentUrl = url;
  let hops = 0;

  while (true) {
    // Synchronous scheme/literal-IP check
    assertSafeUrlSync(currentUrl);
    // Async DNS check
    await assertSafeDns(new URL(currentUrl).hostname);

    const response = await fetch(currentUrl, {
      signal,
      redirect: "manual",
    });

    const isRedirect =
      response.status >= 300 &&
      response.status < 400 &&
      response.headers.has("location");

    if (!isRedirect) {
      return response;
    }

    hops++;
    if (hops > MAX_REDIRECTS) {
      throw new Error(`Too many redirects (max ${MAX_REDIRECTS}) for resource URL.`);
    }

    const location = response.headers.get("location");
    // Resolve relative redirects against the current URL
    currentUrl = new URL(location, currentUrl).toString();

    // Drain the redirect response body
    await response.body?.cancel();
  }
}

// ---------------------------------------------------------------------------
// CSV detection helpers
// ---------------------------------------------------------------------------

/** Return true if the URL path or content-type clearly indicate CSV. */
function looksLikeCsv(url, contentType) {
  const pathLower = new URL(url).pathname.toLowerCase();
  const ctLower = (contentType ?? "").toLowerCase();
  return (
    pathLower.endsWith(".csv") ||
    ctLower.includes("text/csv") ||
    ctLower.includes("application/csv") ||
    ctLower.includes("text/plain") // some Italian portals serve CSV as text/plain
  );
}

// ---------------------------------------------------------------------------
// RFC 4180 CSV parser
// ---------------------------------------------------------------------------

/**
 * Detect the delimiter by counting occurrences outside quoted fields in the
 * first (non-empty) line of text.
 * @param {string} firstLine
 * @returns {string} One of ",", ";", "\t"
 */
function detectDelimiter(firstLine) {
  const candidates = [",", ";", "\t"];
  let best = ",";
  let bestCount = -1;
  for (const delim of candidates) {
    let count = 0;
    let inQuote = false;
    for (let i = 0; i < firstLine.length; i++) {
      const ch = firstLine[i];
      if (ch === '"') {
        if (inQuote && firstLine[i + 1] === '"') {
          i++; // escaped quote
        } else {
          inQuote = !inQuote;
        }
      } else if (!inQuote && ch === delim) {
        count++;
      }
    }
    if (count > bestCount) {
      bestCount = count;
      best = delim;
    }
  }
  return best;
}

/**
 * Parse CSV text into an array of string arrays using RFC 4180 rules.
 * Handles quoted fields (with double-quote escaping) and multi-line fields.
 *
 * @param {string} text      Full CSV text
 * @param {string} delimiter Single-character field delimiter
 * @returns {string[][]}
 */
function parseCsv(text, delimiter) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuote = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (inQuote) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuote = false;
          i++;
        }
      } else {
        field += ch;
        i++;
      }
    } else {
      if (ch === '"') {
        inQuote = true;
        i++;
      } else if (ch === delimiter) {
        row.push(field);
        field = "";
        i++;
      } else if (ch === "\r" && text[i + 1] === "\n") {
        row.push(field);
        field = "";
        rows.push(row);
        row = [];
        i += 2;
      } else if (ch === "\n") {
        row.push(field);
        field = "";
        rows.push(row);
        row = [];
        i++;
      } else {
        field += ch;
        i++;
      }
    }
  }

  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  if (rows.length > 0) {
    const last = rows[rows.length - 1];
    if (last.length === 1 && last[0] === "") {
      rows.pop();
    }
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Main exported function
// ---------------------------------------------------------------------------

/**
 * Preview the first rows of a CSV resource.
 *
 * @param {string} resourceUrl  Public http/https URL to a CSV file
 * @param {number} [rows=20]    Number of data rows to return (excluding header)
 * @returns {Promise<string>}   Formatted preview text
 */
const CSV_CACHE_TTL = 15 * 60 * 1000; // 15 minutes

export async function previewCsv(resourceUrl, rows = 20) {
  // Synchronous scheme + literal-IP check (fast path, no network)
  assertSafeUrlSync(resourceUrl);

  const maxRows = Number(rows) || 20;

  const cacheKey = `csv:${resourceUrl}:${maxRows}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  let response;
  try {
    response = await safeFetch(resourceUrl, controller.signal);
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      throw new Error(`CSV download timed out after ${DOWNLOAD_TIMEOUT_MS / 1000} s`);
    }
    throw err;
  }

  if (!response.ok) {
    clearTimeout(timer);
    throw new Error(`HTTP ${response.status} when fetching resource URL`);
  }

  const contentType = response.headers.get("content-type") ?? "";

  if (!looksLikeCsv(resourceUrl, contentType)) {
    clearTimeout(timer);
    await response.body?.cancel();
    throw new Error(
      `Resource does not appear to be a CSV file. ` +
        `URL path: "${new URL(resourceUrl).pathname}", Content-Type: "${contentType}". ` +
        `Only CSV resources are supported.`
    );
  }

  // Stream and accumulate, aborting at SIZE_LIMIT
  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  let abortedDueToSize = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > SIZE_LIMIT) {
        abortedDueToSize = true;
        controller.abort();
        break;
      }
      chunks.push(value);
    }
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }

  if (abortedDueToSize) {
    throw new Error(
      `Resource exceeds the 5 MB preview limit. ` +
        `Use the dataset's direct download URL for full access.`
    );
  }

  // Decode UTF-8
  const decoder = new TextDecoder("utf-8");
  let text = decoder.decode(
    chunks.reduce((acc, chunk) => {
      const merged = new Uint8Array(acc.byteLength + chunk.byteLength);
      merged.set(acc, 0);
      merged.set(chunk, acc.byteLength);
      return merged;
    }, new Uint8Array(0))
  );

  // Strip UTF-8 BOM
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }

  if (!text.trim()) {
    throw new Error("The CSV resource appears to be empty.");
  }

  const firstLine = text.split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
  const delimiter = detectDelimiter(firstLine);
  const allRows = parseCsv(text, delimiter);

  if (allRows.length === 0) {
    throw new Error("Could not parse any rows from the CSV resource.");
  }

  const delimiterName =
    delimiter === "," ? "comma (,)" : delimiter === ";" ? "semicolon (;)" : "tab (\\t)";

  const header = allRows[0];
  const dataRows = allRows.slice(1, 1 + maxRows);
  const totalDataRows = allRows.length - 1;

  const lines = [
    `Delimiter detected: ${delimiterName}`,
    `Columns (${header.length}): ${header.join(delimiter)}`,
    `Showing ${dataRows.length} of ${totalDataRows} data rows:`,
    "",
    ...dataRows.map((r) => r.join(delimiter)),
  ];

  const result = lines.join("\n");
  cacheSet(cacheKey, result, CSV_CACHE_TTL);
  return result;
}
