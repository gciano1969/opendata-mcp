import { test, describe, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { previewCsv } from "../src/tools/previewCsv.js";
import dns from "node:dns/promises";
import { cacheClear } from "../src/cache.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wrap a plain string as a minimal ReadableStream of Uint8Array chunks. */
function makeStream(text) {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** Build a mock fetch response for a CSV body. */
function csvResponse(text, contentType = "text/csv") {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (h) => (h === "content-type" ? contentType : null),
      has: () => false,
    },
    body: makeStream(text),
  };
}

/** Stub dns.lookup to return a single public IPv4 address. */
function stubPublicDns() {
  dns.lookup = async () => [{ address: "1.2.3.4", family: 4 }];
}

describe("previewCsv", () => {
  let originalFetch;
  let originalDnsLookup;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalDnsLookup = dns.lookup;
    cacheClear();
    // Default: resolve all hostnames to a public IP so dns never makes real calls
    stubPublicDns();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    dns.lookup = originalDnsLookup;
    cacheClear();
  });

  // ---------------------------------------------------------------------------
  // Happy path: comma-delimited CSV
  // ---------------------------------------------------------------------------
  test("parses a standard comma-delimited CSV", async () => {
    const csv = "name,age,city\nAlice,30,Rome\nBob,25,Milan\n";
    globalThis.fetch = async () => csvResponse(csv);

    const output = await previewCsv("https://example.com/data.csv", 10);

    assert.ok(output.includes("comma (,)"), "should detect comma delimiter");
    assert.ok(output.includes("name,age,city"), "header should be present");
    assert.ok(output.includes("Alice"), "data rows should be present");
  });

  // ---------------------------------------------------------------------------
  // Happy path: semicolon-delimited CSV (Italian open data style)
  // ---------------------------------------------------------------------------
  test("auto-detects semicolon delimiter", async () => {
    const csv = "comune;provincia;popolazione\nRoma;RM;2800000\nMilano;MI;1400000\n";
    globalThis.fetch = async () => csvResponse(csv);

    const output = await previewCsv("https://example.com/data.csv", 5);

    assert.ok(output.includes("semicolon (;)"), "should detect semicolon delimiter");
    assert.ok(output.includes("comune;provincia;popolazione"), "header should be present");
    assert.ok(output.includes("Roma"), "data rows should be present");
  });

  // ---------------------------------------------------------------------------
  // BOM stripping
  // ---------------------------------------------------------------------------
  test("strips UTF-8 BOM from the start of the file", async () => {
    const bom = "\uFEFF";
    const csv = `${bom}id,value\n1,alpha\n2,beta\n`;
    globalThis.fetch = async () => csvResponse(csv);

    const output = await previewCsv("https://example.com/data.csv", 5);

    assert.ok(!output.includes("\uFEFF"), "BOM should be stripped");
    assert.ok(output.includes("id,value"), "header should not contain BOM");
  });

  // ---------------------------------------------------------------------------
  // Quoted fields with embedded delimiter
  // ---------------------------------------------------------------------------
  test("handles RFC 4180 quoted fields with embedded delimiter", async () => {
    const csv = `name,description\nProduct A,"Has commas, inside"\n"Product ""B""",plain\n`;
    globalThis.fetch = async () => csvResponse(csv);

    const output = await previewCsv("https://example.com/data.csv", 10);

    assert.ok(output.includes("Has commas, inside"), "quoted field with delimiter should be preserved");
    assert.ok(output.includes('Product "B"'), "escaped quotes should be unescaped");
  });

  // ---------------------------------------------------------------------------
  // Non-CSV URL rejected (by extension)
  // ---------------------------------------------------------------------------
  test("rejects non-CSV URL by file extension", async () => {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "application/json", has: () => false },
      body: makeStream("{}"),
    });

    await assert.rejects(
      () => previewCsv("https://example.com/data.json", 5),
      /does not appear to be a CSV/
    );
  });

  // ---------------------------------------------------------------------------
  // Non-http scheme rejected
  // ---------------------------------------------------------------------------
  test("rejects file:// URLs", async () => {
    await assert.rejects(
      () => previewCsv("file:///etc/passwd", 5),
      /non-http\/https/
    );
  });

  test("rejects ftp:// URLs", async () => {
    await assert.rejects(
      () => previewCsv("ftp://example.com/data.csv", 5),
      /non-http\/https/
    );
  });

  // ---------------------------------------------------------------------------
  // Private IP addresses rejected (literal IPs in URL — synchronous check)
  // ---------------------------------------------------------------------------
  test("rejects localhost URL", async () => {
    await assert.rejects(
      () => previewCsv("http://localhost/data.csv", 5),
      /localhost/
    );
  });

  test("rejects 127.x.x.x loopback IP", async () => {
    await assert.rejects(
      () => previewCsv("http://127.0.0.1/data.csv", 5),
      /private\/loopback/
    );
  });

  test("rejects 10.x.x.x private IP", async () => {
    await assert.rejects(
      () => previewCsv("http://10.0.0.1/data.csv", 5),
      /private\/loopback/
    );
  });

  test("rejects 192.168.x.x private IP", async () => {
    await assert.rejects(
      () => previewCsv("http://192.168.1.100/data.csv", 5),
      /private\/loopback/
    );
  });

  test("rejects 172.16-31.x.x private IP", async () => {
    await assert.rejects(
      () => previewCsv("http://172.20.0.1/data.csv", 5),
      /private\/loopback/
    );
  });

  // ---------------------------------------------------------------------------
  // File exceeds 5 MB → aborted
  // ---------------------------------------------------------------------------
  test("aborts download when size exceeds 5 MB", async () => {
    const bigChunk = new Uint8Array(5 * 1024 * 1024 + 1);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(bigChunk);
        controller.close();
      },
    });

    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: (h) => (h === "content-type" ? "text/csv" : null), has: () => false },
      body: stream,
    });

    await assert.rejects(
      () => previewCsv("https://example.com/data.csv", 5),
      /5 MB/
    );
  });

  // ---------------------------------------------------------------------------
  // HTTP error propagation
  // ---------------------------------------------------------------------------
  test("propagates HTTP error from server", async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 404,
      headers: { get: () => null, has: () => false },
      body: makeStream(""),
    });

    await assert.rejects(
      () => previewCsv("https://example.com/data.csv", 5),
      /HTTP 404/
    );
  });
});

// ---------------------------------------------------------------------------
// DNS rebinding and redirect security tests
// These mock dns.lookup to exercise assertSafeDns and safeFetch without
// making real network calls.
// ---------------------------------------------------------------------------

describe("previewCsv — DNS and redirect security", () => {
  let originalFetch;
  let originalDnsLookup;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalDnsLookup = dns.lookup;
    cacheClear();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    dns.lookup = originalDnsLookup;
    cacheClear();
  });

  test("rejects when hostname resolves to a loopback IPv4 address (DNS rebinding)", async () => {
    dns.lookup = async () => [{ address: "127.0.0.1", family: 4 }];

    await assert.rejects(
      () => previewCsv("https://evil.example.com/data.csv", 5),
      /resolves to private\/loopback/
    );
  });

  test("rejects when hostname resolves to a private RFC-1918 address", async () => {
    dns.lookup = async () => [{ address: "10.0.0.1", family: 4 }];

    await assert.rejects(
      () => previewCsv("https://evil.example.com/data.csv", 5),
      /resolves to private\/loopback/
    );
  });

  test("rejects when hostname resolves to an IPv6 loopback address", async () => {
    dns.lookup = async () => [{ address: "::1", family: 6 }];

    await assert.rejects(
      () => previewCsv("https://evil.example.com/data.csv", 5),
      /resolves to private\/loopback/
    );
  });

  test("rejects when hostname resolves to a link-local IPv4 address", async () => {
    dns.lookup = async () => [{ address: "169.254.1.1", family: 4 }];

    await assert.rejects(
      () => previewCsv("https://evil.example.com/data.csv", 5),
      /resolves to private\/loopback/
    );
  });

  test("follows a safe redirect and returns CSV content", async () => {
    dns.lookup = async () => [{ address: "1.2.3.4", family: 4 }];

    const csv = "a,b\n1,2\n";
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      if (callCount === 1) {
        return {
          ok: false,
          status: 302,
          headers: {
            get: (h) => (h === "location" ? "https://redirect.example.com/data.csv" : null),
            has: (h) => h === "location",
          },
          body: { cancel: async () => {} },
        };
      }
      const bytes = new TextEncoder().encode(csv);
      return {
        ok: true,
        status: 200,
        headers: { get: (h) => (h === "content-type" ? "text/csv" : null), has: () => false },
        body: new ReadableStream({
          start(c) { c.enqueue(bytes); c.close(); },
        }),
      };
    };

    const output = await previewCsv("https://example.com/data.csv", 5);
    assert.ok(output.includes("a,b"), "should return CSV header after redirect");
    assert.equal(callCount, 2, "should follow one redirect");
  });

  test("rejects after too many redirects", async () => {
    dns.lookup = async () => [{ address: "1.2.3.4", family: 4 }];

    globalThis.fetch = async () => ({
      ok: false,
      status: 302,
      headers: {
        get: (h) => (h === "location" ? "https://loop.example.com/data.csv" : null),
        has: (h) => h === "location",
      },
      body: { cancel: async () => {} },
    });

    await assert.rejects(
      () => previewCsv("https://example.com/data.csv", 5),
      /Too many redirects/
    );
  });

  test("rejects a redirect that points to a private IP", async () => {
    let callCount = 0;
    dns.lookup = async (hostname) => {
      if (hostname === "example.com") return [{ address: "1.2.3.4", family: 4 }];
      return [{ address: "192.168.0.1", family: 4 }];
    };

    globalThis.fetch = async () => {
      callCount++;
      if (callCount === 1) {
        return {
          ok: false,
          status: 302,
          headers: {
            get: (h) => (h === "location" ? "https://internal.corp/data.csv" : null),
            has: (h) => h === "location",
          },
          body: { cancel: async () => {} },
        };
      }
      return { ok: true, status: 200, headers: { get: () => null, has: () => false }, body: null };
    };

    await assert.rejects(
      () => previewCsv("https://example.com/data.csv", 5),
      /resolves to private\/loopback/
    );
  });
});
