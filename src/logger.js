/**
 * Structured logger — writes JSON lines to stderr only.
 *
 * stdout is reserved for the MCP stdio transport; never write to it here.
 */

/**
 * Log a tool error to stderr as a JSON line.
 *
 * @param {string} tool   Tool name, e.g. "search_datasets"
 * @param {Error}  err    The caught error
 * @param {object} [ctx]  Optional extra context (e.g. { query, id })
 */
export function logError(tool, err, ctx = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level: "error",
    tool,
    message: err.message,
    ...ctx,
  };
  process.stderr.write(JSON.stringify(entry) + "\n");
}
