import { test, describe, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { searchDatasets } from "../src/tools/searchDatasets.js";
import { cacheClear } from "../src/cache.js";

const MOCK_RESULT = {
  count: 2,
  results: [
    {
      id: "abc-123",
      title: "Popolazione residente",
      organization: { title: "ISTAT", name: "istat" },
      metadata_modified: "2024-01-15T10:00:00",
      resources: [
        { format: "CSV", url: "https://example.com/file.csv" },
        { format: "csv", url: "https://example.com/file2.csv" }, // duplicate
        { format: "JSON", url: "https://example.com/file.json" },
      ],
    },
    {
      id: "def-456",
      title: "Dati meteo",
      organization: null,
      metadata_modified: "2023-06-01T08:00:00",
      resources: [],
    },
  ],
};

describe("searchDatasets", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    cacheClear();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    cacheClear();
  });

  test("returns formatted dataset list on success", async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ success: true, result: MOCK_RESULT }),
    });

    const output = JSON.parse(await searchDatasets("popolazione", undefined, 10));

    assert.equal(output.total, 2);
    assert.equal(output.datasets.length, 2);

    const first = output.datasets[0];
    assert.equal(first.id, "abc-123");
    assert.equal(first.title, "Popolazione residente");
    assert.equal(first.organization, "ISTAT");
    // Formats should be deduped and uppercased
    assert.deepEqual(first.formats, ["CSV", "JSON"]);
  });

  test("handles organization filter parameter", async () => {
    let capturedUrl;
    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        json: async () => ({ success: true, result: { count: 0, results: [] } }),
      };
    };

    await searchDatasets("test", "istat", 5);

    assert.ok(capturedUrl.includes("fq=organization"), "should include fq param");
    assert.ok(capturedUrl.includes("rows=5"), "should include rows param");
  });

  test("handles empty results gracefully", async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ success: true, result: { count: 0, results: [] } }),
    });

    const output = JSON.parse(await searchDatasets("zzznoresults"));
    assert.equal(output.total, 0);
    assert.deepEqual(output.datasets, []);
  });

  test("propagates CKAN errors", async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ success: false, error: { message: "Bad query" } }),
    });

    await assert.rejects(() => searchDatasets("test"), /CKAN error/);
  });

  test("caps max_results at HARD_MAX (50)", async () => {
    let capturedUrl;
    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        json: async () => ({ success: true, result: { count: 0, results: [] } }),
      };
    };

    await searchDatasets("test", undefined, 999);
    assert.ok(capturedUrl.includes("rows=50"), "rows should be capped at 50");
  });
});
