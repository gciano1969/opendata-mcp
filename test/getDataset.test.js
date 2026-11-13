import { test, describe, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { getDataset } from "../src/tools/getDataset.js";
import { cacheClear } from "../src/cache.js";

const MOCK_PACKAGE = {
  id: "pkg-uuid-001",
  title: "Dati Open ISTAT",
  notes: "Descrizione del dataset con molti dettagli.",
  license_title: "Creative Commons Attribution",
  organization: { title: "ISTAT", name: "istat" },
  metadata_modified: "2024-03-10T12:00:00",
  resources: [
    { name: "File CSV", format: "csv", url: "https://example.com/data.csv" },
    { id: "res-002", format: "", url: "https://example.com/data.json" },
  ],
};

describe("getDataset", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    cacheClear();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    cacheClear();
  });

  test("returns formatted dataset metadata on success", async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ success: true, result: MOCK_PACKAGE }),
    });

    const output = JSON.parse(await getDataset("pkg-uuid-001"));

    assert.equal(output.id, "pkg-uuid-001");
    assert.equal(output.title, "Dati Open ISTAT");
    assert.equal(output.organization, "ISTAT");
    assert.equal(output.license_title, "Creative Commons Attribution");
    assert.equal(output.resources.length, 2);
    assert.equal(output.resources[0].format, "CSV");
    // Resource with no format should fall back to "unknown"
    assert.equal(output.resources[1].format, "unknown");
  });

  test("truncates notes longer than 500 characters", async () => {
    const longNotes = "A".repeat(600);
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        success: true,
        result: { ...MOCK_PACKAGE, notes: longNotes },
      }),
    });

    const output = JSON.parse(await getDataset("pkg-uuid-001"));
    assert.ok(output.notes.length <= 520, "notes should be truncated");
    assert.ok(output.notes.includes("[truncated]"), "notes should indicate truncation");
  });

  test("propagates CKAN error for unknown id", async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ success: false, error: { message: "Not found" } }),
    });

    await assert.rejects(() => getDataset("bad-id"), /CKAN error/);
  });

  test("returns license_id and license_url in output", async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        success: true,
        result: {
          ...MOCK_PACKAGE,
          license_id: "cc-by",
          license_url: "https://creativecommons.org/licenses/by/4.0/",
        },
      }),
    });

    const output = JSON.parse(await getDataset("pkg-uuid-001"));
    assert.equal(output.license_id, "cc-by");
    assert.equal(output.license_url, "https://creativecommons.org/licenses/by/4.0/");
  });

  test("returns null for missing license fields gracefully", async () => {
    const { license_id: _, license_url: __, ...rest } = MOCK_PACKAGE;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ success: true, result: rest }),
    });

    const output = JSON.parse(await getDataset("pkg-uuid-001"));
    assert.equal(output.license_id, null);
    assert.equal(output.license_url, null);
  });
});
