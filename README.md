# opendata-mcp

An MCP server that gives AI agents **read-only access to the Italian open data catalogue** at [dati.gov.it](https://www.dati.gov.it) through its public [CKAN API](https://www.dati.gov.it/opendata/api/3/action/). No API key required.

Transport: **stdio** — compatible with any MCP client that supports stdio servers (Claude Desktop, Bob, Cursor, etc.).

---

## Prerequisites

- **Node.js 18 or later** (uses the built-in `fetch` API)

---

## Installation

```bash
git clone <repo-url> opendata-mcp
cd opendata-mcp
npm install
```

---

## Running

```bash
npm start
# or directly:
node src/index.js
```

The server listens on **stdin/stdout** and is intended to be launched by an MCP client, not run interactively.

---

## Tools

### `search_datasets`

Search the Italian open data catalogue for datasets matching a query.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `query` | string | required | Free-text search, e.g. `"popolazione residente comuni"` |
| `organization` | string | — | CKAN organisation slug to filter results, e.g. `"istat"` |
| `max_results` | integer | `10` | Number of results to return (1–50) |

Returns a JSON object with `total` (catalogue match count) and `datasets` — an array of:
- `id` — unique dataset id (pass to `get_dataset`)
- `title` — human-readable title
- `organization` — publishing organisation name
- `metadata_modified` — ISO 8601 date of last update
- `formats` — deduped list of available file formats, e.g. `["CSV", "JSON"]`

---

### `get_dataset`

Retrieve full metadata for a single dataset by its id.

| Parameter | Type | Description |
|---|---|---|
| `id` | string | Dataset id (UUID) or slug, as returned by `search_datasets` |

Returns a JSON object with `id`, `title`, `notes` (description, truncated to 500 chars), `license_title`, `organization`, `metadata_modified`, and `resources` — an array of `{ name, format, url }`. Use the `url` values with `preview_csv` to inspect CSV files.

---

### `preview_csv`

Download and preview the first rows of a CSV resource.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `resource_url` | string (URL) | required | Public http/https URL to a CSV file |
| `rows` | integer | `20` | Number of data rows to preview, excluding the header (1–200) |

The tool:
- **Auto-detects the delimiter** (comma, semicolon, or tab) — Italian open data often uses semicolons.
- **Handles RFC 4180 quoted fields** including embedded delimiters and newlines.
- **Strips a UTF-8 BOM** if present.
- **Enforces a 5 MB download cap** — aborts the stream if the file is larger.
- **Refuses non-CSV files** (checked by URL extension and `Content-Type` header).
- **Refuses non-http/https URLs** and requests to localhost or private IP ranges.

---

## MCP client configuration

Add the following to your MCP client configuration file (commonly `mcp.json`, `mcp_config.json`, or the client's settings panel):

```json
{
  "mcpServers": {
    "opendata-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/opendata-mcp/src/index.js"],
      "transport": "stdio"
    }
  }
}
```

Replace `/absolute/path/to/opendata-mcp` with the actual path where you cloned the repository.

### Example: Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "opendata-mcp": {
      "command": "node",
      "args": ["/Users/yourname/opendata-mcp/src/index.js"]
    }
  }
}
```

### Example: Bob (`mcp.json`)

```json
{
  "mcpServers": {
    "opendata-mcp": {
      "command": "node",
      "args": ["/Users/yourname/opendata-mcp/src/index.js"],
      "transport": "stdio"
    }
  }
}
```

---

## Running the tests

```bash
npm test
```

Uses Node's built-in `node --test` runner — no additional dependencies required. All 27 tests run in under a second; HTTP calls are mocked and no network access is needed.

---

## Project layout

```
opendata-mcp/
├── src/
│   ├── index.js              # MCP server entry point (tool registration)
│   ├── ckan.js               # CKAN HTTP client (timeout, error normalisation)
│   └── tools/
│       ├── searchDatasets.js # search_datasets implementation
│       ├── getDataset.js     # get_dataset implementation
│       └── previewCsv.js     # preview_csv implementation (RFC 4180 parser)
├── test/
│   ├── ckan.test.js
│   ├── searchDatasets.test.js
│   ├── getDataset.test.js
│   └── previewCsv.test.js
├── package.json
└── README.md
```

---

## Licence and attribution

Most datasets on dati.gov.it are published under **Creative Commons Attribution 4.0 (CC BY 4.0)** or the **Italian Open Data Licence 2.0 (IODL 2.0)**. Both licences require that the source be credited whenever the data is used, reproduced, or incorporated into a downstream product.

The `get_dataset` tool returns `license_title`, `license_id`, and `license_url` for every dataset. AI agents and applications built on top of this server **must cite the publisher (`organization`) and the licence** when presenting or republishing data retrieved through these tools.

If you are unsure whether a specific use is permitted, consult the licence URL returned by `get_dataset` or contact the publishing organisation directly.

---

## Limitations

- **Read-only** — the CKAN API is queried but never written to.
- **No authentication** — the dati.gov.it CKAN API is fully public.
- **CSV preview only** — `preview_csv` supports CSV files; other formats (XLS, JSON, RDF, …) must be downloaded and processed separately.
- **Notes truncated** — `get_dataset` truncates the dataset description to 500 characters to keep tool responses compact for LLM context windows.
