/**
 * opendata-mcp — MCP server entry point
 *
 * Exposes three read-only tools that let AI agents query the Italian open
 * data catalogue at dati.gov.it via its public CKAN API.
 *
 * Transport: stdio (compatible with any MCP client that supports stdio servers)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { searchDatasets } from "./tools/searchDatasets.js";
import { getDataset } from "./tools/getDataset.js";
import { previewCsv } from "./tools/previewCsv.js";
import { logError } from "./logger.js";

// ---------------------------------------------------------------------------
// Server instance
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "opendata-mcp",
  version: "1.0.0",
});

// ---------------------------------------------------------------------------
// Tool: search_datasets
// ---------------------------------------------------------------------------

server.tool(
  "search_datasets",
  `Search the Italian open data catalogue (dati.gov.it) for datasets matching a query.

Returns a JSON object with a 'total' count and a 'datasets' array. Each dataset entry contains:
- id: unique dataset identifier (use this with get_dataset)
- title: human-readable title
- organization: publishing organisation name
- metadata_modified: ISO 8601 date of last update
- formats: list of available file formats (e.g. ["CSV", "JSON"])

Use 'organization' to narrow results to a specific publisher (use the CKAN organisation slug).
Use 'max_results' to control how many datasets are returned (default 10, max 50).`,
  {
    query: z.string().max(500).describe("Free-text search query, e.g. 'popolazione residente comuni'"),
    organization: z
      .string()
      .regex(/^[a-z0-9_-]{1,100}$/, "organisation slug must be lowercase alphanumeric with hyphens/underscores")
      .optional()
      .describe("CKAN organisation slug to filter results, e.g. 'istat'"),
    max_results: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe("Maximum number of datasets to return (1–50, default 10)"),
  },
  async ({ query, organization, max_results }) => {
    try {
      const text = await searchDatasets(query, organization, max_results);
      return { content: [{ type: "text", text }] };
    } catch (err) {
      logError("search_datasets", err, { query, organization });
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: get_dataset
// ---------------------------------------------------------------------------

server.tool(
  "get_dataset",
  `Retrieve full metadata for a single dataset from the Italian open data catalogue (dati.gov.it).

Provide the dataset 'id' obtained from search_datasets.

Returns a JSON object with:
- id, title, notes (description, up to 500 chars), license_title, license_id, license_url, organization, metadata_modified
- resources: array of { name, format, url } — use the url with preview_csv to inspect CSV files

Always cite the license_title and organization when using or presenting this dataset's data.`,
  {
    id: z
      .string()
      .regex(/^[a-z0-9_-]{1,100}$/, "id must be a CKAN slug or UUID (lowercase alphanumeric, hyphens, underscores)")
      .describe("Dataset id (UUID) or slug as returned by search_datasets"),
  },
  async ({ id }) => {
    try {
      const text = await getDataset(id);
      return { content: [{ type: "text", text }] };
    } catch (err) {
      logError("get_dataset", err, { id });
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: preview_csv
// ---------------------------------------------------------------------------

server.tool(
  "preview_csv",
  `Download and preview the first rows of a CSV resource from dati.gov.it (or any public http/https URL).

Automatically detects the delimiter (comma, semicolon, or tab) — Italian open data often uses semicolons.
Strips the UTF-8 BOM if present. Handles RFC 4180 quoted fields.

Returns:
- The detected delimiter
- The column names (header row)
- The first 'rows' data rows (default 20)

Refuses:
- Non-CSV files (checked by URL extension and Content-Type header)
- Files larger than 5 MB
- Non-http/https URLs
- Localhost and private IP addresses`,
  {
    resource_url: z
      .string()
      .url()
      .describe("Public http/https URL to a CSV resource, as returned in get_dataset resources"),
    rows: z
      .number()
      .int()
      .min(1)
      .max(200)
      .default(20)
      .describe("Number of data rows to preview, excluding the header (default 20, max 200)"),
  },
  async ({ resource_url, rows }) => {
    try {
      const text = await previewCsv(resource_url, rows);
      return { content: [{ type: "text", text }] };
    } catch (err) {
      logError("preview_csv", err, { resource_url });
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
