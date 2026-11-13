import { test, describe, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { ckanGet } from "../src/ckan.js";
import { cacheClear } from "../src/cache.js";

// Helper to build a minimal CKAN-envelope fetch mock
function makeFetchMock(responseInit) {
  return async () => responseInit;
}

describe("ckanGet", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    cacheClear();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    cacheClear();
  });

  test("builds correct URL and returns result field", async () => {
    let capturedUrl;
    globalThis.fetch = async (url, _opts) => {
      capturedUrl = url;
      return {
        ok: true,
        json: async () => ({ success: true, result: { count: 1, results: [] } }),
      };
    };

    const result = await ckanGet("package_search", { q: "hello", rows: 5 });

    assert.ok(capturedUrl.includes("package_search"), "URL should contain action name");
    assert.ok(capturedUrl.includes("q=hello"), "URL should include q param");
    assert.ok(capturedUrl.includes("rows=5"), "URL should include rows param");
    assert.deepEqual(result, { count: 1, results: [] });
  });

  test("throws friendly message on HTTP error", async () => {
    globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });

    await assert.rejects(
      () => ckanGet("package_search", {}),
      /HTTP 500/
    );
  });

  test("throws friendly message when CKAN success=false", async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ success: false, error: { message: "Not found" } }),
    });

    await assert.rejects(
      () => ckanGet("package_show", { id: "bad-id" }),
      /CKAN error/
    );
  });

  test("throws timeout message when AbortError is raised", async () => {
    globalThis.fetch = async (_url, { signal }) => {
      // Simulate the signal already being aborted
      await new Promise((_, reject) => {
        const err = new DOMException("aborted", "AbortError");
        reject(err);
      });
    };

    await assert.rejects(
      () => ckanGet("package_search", {}),
      /timed out/
    );
  });

  test("throws network error message on generic failure", async () => {
    globalThis.fetch = async () => {
      throw new TypeError("fetch failed");
    };

    await assert.rejects(
      () => ckanGet("package_search", {}),
      /Network error/
    );
  });

  test("caches result and avoids second fetch", async () => {
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      return {
        ok: true,
        json: async () => ({ success: true, result: { count: 1, results: [] } }),
      };
    };

    await ckanGet("package_search", { q: "test" });
    await ckanGet("package_search", { q: "test" });

    assert.equal(callCount, 1, "fetch should only be called once due to caching");
  });

  test("makes a fresh request for a different cache key", async () => {
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      return {
        ok: true,
        json: async () => ({ success: true, result: { count: 0, results: [] } }),
      };
    };

    await ckanGet("package_search", { q: "first" });
    await ckanGet("package_search", { q: "second" });

    assert.equal(callCount, 2, "different queries should each trigger a fetch");
  });
});
