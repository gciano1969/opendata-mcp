import { test, describe, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { cacheGet, cacheSet, cacheClear } from "../src/cache.js";

describe("cache", () => {
  beforeEach(() => cacheClear());
  afterEach(() => cacheClear());

  test("stores and retrieves a value", () => {
    cacheSet("k1", { data: 42 }, 5000);
    assert.deepEqual(cacheGet("k1"), { data: 42 });
  });

  test("returns undefined for missing key", () => {
    assert.equal(cacheGet("missing"), undefined);
  });

  test("returns undefined for expired entry", () => {
    cacheSet("k2", "value", -1); // already expired
    assert.equal(cacheGet("k2"), undefined);
  });

  test("does not evict unexpired entries", () => {
    cacheSet("k3", "alive", 60_000);
    assert.equal(cacheGet("k3"), "alive");
  });
});
