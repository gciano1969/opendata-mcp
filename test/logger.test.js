import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { logError } from "../src/logger.js";

describe("logError", () => {
  test("writes a JSON line to stderr and does not throw", () => {
    // Capture one stderr write
    const written = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => { written.push(chunk); return true; };

    try {
      logError("test_tool", new Error("boom"), { id: "abc" });
    } finally {
      process.stderr.write = original;
    }

    assert.equal(written.length, 1);
    const entry = JSON.parse(written[0]);
    assert.equal(entry.level, "error");
    assert.equal(entry.tool, "test_tool");
    assert.equal(entry.message, "boom");
    assert.equal(entry.id, "abc");
    assert.ok(entry.ts, "timestamp should be present");
  });

  test("does not write to stdout", () => {
    const stdoutChunks = [];
    const originalStdout = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { stdoutChunks.push(chunk); return true; };

    // Suppress the stderr write for this test
    const originalStderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = () => true;

    try {
      logError("test_tool", new Error("silent"));
    } finally {
      process.stdout.write = originalStdout;
      process.stderr.write = originalStderr;
    }

    assert.equal(stdoutChunks.length, 0, "logError must never write to stdout");
  });
});
