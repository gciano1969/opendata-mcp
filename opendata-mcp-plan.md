# opendata-mcp — Plan

## Top-Level Overview

Build a small, self-contained MCP server in **plain JavaScript** (Node.js, stdio
transport) using the official `@modelcontextprotocol/sdk` package. The server
exposes three read-only tools that give AI agents access to the Italian open data
catalogue at `https://www.dati.gov.it/opendata/api/3/action/` (CKAN API, no API
key required).

**Tools:**
| Tool | Purpose |
|---|---|
| `search_datasets` | Full-text search returning title, publisher, last update, formats, dataset id |
| `get_dataset` | Fetch full metadata for one dataset by id |
| `preview_csv` | Download the first N rows of a CSV resource, enforcing a 5 MB hard cap via stream-and-abort |

**Constraints / non-goals:**
- Plain JavaScript (no TypeScript compilation step)
- No external HTTP library — use Node.js built-in `fetch` (Node 18+)
- No persistent state, no authentication
- Unit tests use Node's built-in `node --test` runner with mocked HTTP calls
- Output trimmed so tool responses stay small enough for LLM context windows
- Keep the project to a handful of files

---

## Sub-Tasks

---

### Sub-Task 1 — Project scaffold

**Status:** `[ ] pending`

**Intent**
Create the package skeleton: `package.json`, `.gitignore`, and the top-level
directory layout. This establishes the runtime (Node 18+), declares the single
runtime dependency (`@modelcontextprotocol/sdk`), registers the `start` script,
and opts in to ES modules so `import`/`export` syntax works throughout.

**Expected Outcomes**
- `package.json` present with `"type": "module"`, `"engines": {"node": ">=18"}`,
  `@modelcontextprotocol/sdk` as a dependency, `"start": "node src/index.js"` and
  `"test": "node --test"` scripts.
- `.gitignore` ignoring `node_modules/`.
- `src/` directory created (empty files acceptable as placeholders).
- `npm install` completes without errors.

**Todo List**
1. Create `package.json` with the fields described above.
2. Create `.gitignore`.
3. Create the `src/` directory structure: `src/index.js`, `src/tools/`,
   `src/ckan.js`.
4. Run `npm install` to generate `package-lock.json`.

**Relevant Context**
- MCP SDK package name: `@modelcontextprotocol/sdk`
- ES module entry points in the SDK are under `@modelcontextprotocol/sdk/server/...`

---

### Sub-Task 2 — CKAN HTTP client (`src/ckan.js`)

**Status:** `[ ] pending`

**Intent**
Centralise all HTTP communication with the CKAN API in one module. All three
tools call the same base URL; keeping this logic in one place makes it easy to
mock in tests and to enforce the timeout policy uniformly.

**Expected Outcomes**
- `src/ckan.js` exports a single async function `ckanGet(action, params)` that:
  - Builds the URL from `BASE_URL + action` with `params` serialised as query
    string.
  - Uses `AbortController` + `setTimeout` to enforce a **10-second timeout**.
  - Throws a descriptive `Error` (never throws raw fetch rejections) on timeout,
    HTTP error status, or `success: false` in the CKAN JSON envelope.
  - Returns the `result` field of a successful CKAN response.

**Todo List**
1. Define `BASE_URL = "https://www.dati.gov.it/opendata/api/3/action/"`.
2. Implement `ckanGet` with AbortController timeout.
3. Map error conditions to friendly English messages (e.g. "CKAN request timed
   out after 10 s", "CKAN returned HTTP 500", "CKAN error: <error field>").
4. Export `ckanGet` as a named export.

**Relevant Context**
- CKAN actions used: `package_search`, `package_show`
- CKAN response envelope: `{ success: true, result: { ... } }`
- Node 18+ `fetch` is available globally; no `node-fetch` needed.

---

### Sub-Task 3 — Tool implementations (`src/tools/`)

**Status:** `[ ] pending`

**Intent**
Implement each of the three tool functions as individual modules. Each module
exports a single async function that takes validated arguments, calls `ckanGet`
(or native fetch for CSV streaming), trims the result, and returns a plain
string suitable for passing back to the MCP framework as tool output.

**Expected Outcomes**

**`src/tools/searchDatasets.js`**
- Calls `package_search` with `q`, `rows`, and optionally `fq=organization:<org>`.
- Returns a JSON string with an array of objects, each containing:
  `id`, `title`, `organization` (title), `metadata_modified`, `formats` (deduped
  list of resource formats).
- Caps results at `max_results` (default 10, hard max 50).

**`src/tools/getDataset.js`**
- Calls `package_show` with the given `id`.
- Returns a JSON string with: `id`, `title`, `notes` (truncated to 500 chars),
  `license_title`, `organization`, `metadata_modified`, and `resources` as an
  array of `{ name, format, url }`.

**`src/tools/previewCsv.js`**
- Accepts `resource_url` and `rows` (default 20).
- Rejects non-CSV URLs early: checks the URL path extension AND the
  `Content-Type` response header; returns a friendly refusal if not CSV.
- Streams the response body, accumulating chunks; aborts via `AbortController`
  once the running byte count exceeds **5 MB**, returning a friendly message.
- Parses the accumulated text with a **hand-rolled RFC 4180-compliant CSV
  parser** (no extra dependencies):
  - Strips a UTF-8 BOM (`\uFEFF`) from the start of the text if present.
  - Auto-detects the delimiter from the first line by counting occurrences of
    `,`, `;`, and `\t` and picking the most frequent — because Italian open data
    often uses `;`.
  - Correctly handles double-quoted fields (including fields that contain the
    delimiter or embedded newlines).
- Rejects non-http/https URLs immediately with a friendly error (e.g. `file://`,
  `ftp://`).
- Rejects requests to `localhost`, `127.x.x.x`, `::1`, and RFC-1918 private IP
  ranges (`10.x`, `172.16–31.x`, `192.168.x`) with a friendly error.
- Returns the header row plus the first `rows` data rows, formatted as plain
  `\n`-delimited lines (one line per row, fields joined by the detected
  delimiter). Includes a note of the detected delimiter in the output.

**Todo List**
1. Create `src/tools/searchDatasets.js`.
2. Create `src/tools/getDataset.js`.
3. Create `src/tools/previewCsv.js` with stream-and-abort logic.
4. Each module: add a short JSDoc comment describing what it does (the LLM-
   facing description lives in the server registration, not here).

**Relevant Context**
- `ckanGet` is imported from `../ckan.js`.
- For CSV streaming, use `response.body` (a `ReadableStream`) and read it with
  an async iterator or `getReader()`.
- Apply a separate **15-second timeout** for the CSV download (longer than the
  API timeout because CSV files can be large).

---

### Sub-Task 4 — MCP server entry point (`src/index.js`)

**Status:** `[ ] pending`

**Intent**
Wire the three tool functions into an MCP `Server` instance and start it on
stdio. This file is the only place that imports the MCP SDK. Tool descriptions
here are written for an LLM — precise, concise, explicit about what each
parameter does and what the tool returns.

**Expected Outcomes**
- Imports `Server` and `StdioServerTransport` from `@modelcontextprotocol/sdk`.
- Registers all three tools with:
  - LLM-friendly `description` strings.
  - JSON Schema `inputSchema` covering every parameter with types and defaults.
- Each tool handler calls the corresponding module function, catches errors, and
  returns `{ content: [{ type: "text", text: ... }], isError: false/true }`.
- Errors from tool functions are caught and returned as `isError: true` text
  content (never thrown to the framework).
- Server starts cleanly with `server.connect(transport)`.

**Todo List**
1. Create `src/index.js`.
2. Register `search_datasets` tool with schema `{ query, organization?, max_results }`.
3. Register `get_dataset` tool with schema `{ id }`.
4. Register `preview_csv` tool with schema `{ resource_url, rows? }`.
5. Write all three tool `description` strings targeting LLM consumption.
6. Add error handler wrapper so no uncaught exception crashes the process.

**Relevant Context**
- MCP SDK v2 API: `server.tool(name, description, inputSchema, handler)` or
  `server.setRequestHandler(ListToolsRequestSchema, ...)` depending on SDK
  version — check the installed SDK's exports to pick the right API.
- Transport: `new StdioServerTransport()`.
- The handler return type is `{ content: Array<{type, text}>, isError?: boolean }`.

---

### Sub-Task 5 — Unit tests (`test/`)

**Status:** `[ ] pending`

**Intent**
Provide a test suite that runs with `node --test` and validates each tool's
behaviour without making real HTTP calls. All network calls are mocked by
monkey-patching `globalThis.fetch` within each test.

**Expected Outcomes**
- `test/searchDatasets.test.js` — tests: normal result, empty result, CKAN
  error, network timeout.
- `test/getDataset.test.js` — tests: happy path, unknown id returns error text.
- `test/previewCsv.test.js` — tests: valid comma-delimited CSV, valid
  semicolon-delimited CSV, BOM stripping, quoted fields with embedded delimiter,
  non-CSV URL rejected, non-http scheme rejected, private IP URL rejected,
  file exceeds 5 MB aborted.
- `test/ckan.test.js` — tests: correct URL construction, timeout behaviour,
  HTTP error handling.
- All tests pass with `npm test`.

**Todo List**
1. Create `test/` directory.
2. Write `test/ckan.test.js`.
3. Write `test/searchDatasets.test.js`.
4. Write `test/getDataset.test.js`.
5. Write `test/previewCsv.test.js`.
6. Ensure all tests pass with `npm test`.

**Relevant Context**
- `node --test` with `import { test, describe, mock } from "node:test"` and
  `import { strict as assert } from "node:assert"`.
- Mock `globalThis.fetch` with `mock.fn(...)` or by temporary reassignment;
  restore after each test to avoid leaking state.
- The CSV stream mock must return a `ReadableStream` or an object with a
  `getReader()` compatible API.

---

### Sub-Task 6 — README

**Status:** `[ ] pending`

**Intent**
Write a `README.md` that lets a developer get the server running in under five
minutes and shows how to wire it into an MCP client config.

**Expected Outcomes**
- Sections: Overview, Prerequisites, Installation, Running, Tools reference
  (one paragraph per tool), MCP client configuration example (JSON block for
  a typical `mcp.json` / `mcpServers` config), Running tests.
- MCP client config example uses `"command": "node"` with `"args":
  ["path/to/opendata-mcp/src/index.js"]` and `"transport": "stdio"`.

**Todo List**
1. Create `README.md` with all sections listed above.

**Relevant Context**
- No API key section needed — the CKAN API is public.
- Mention Node 18+ requirement.
