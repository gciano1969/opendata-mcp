/**
 * search_datasets tool implementation.
 *
 * Performs a full-text search over the dati.gov.it CKAN catalogue and
 * returns a compact list of matching datasets.
 */

import { ckanGet } from "../ckan.js";

const HARD_MAX = 50;

/**
 * Search the Italian open data catalogue.
 *
 * @param {string} query        Free-text search query
 * @param {string} [organization]  Filter by CKAN organisation slug
 * @param {number} [maxResults=10] Number of results to return (capped at 50)
 * @returns {Promise<string>} JSON string with an array of dataset summaries
 */
export async function searchDatasets(query, organization, maxResults = 10) {
  const rows = Math.min(Math.max(1, Number(maxResults) || 10), HARD_MAX);

  const params = { q: query, rows };
  if (organization) {
    params.fq = `organization:${organization}`;
  }

  const result = await ckanGet("package_search", params);

  const datasets = (result.results ?? []).map((pkg) => ({
    id: pkg.id,
    title: pkg.title ?? pkg.name,
    organization: pkg.organization?.title ?? pkg.organization?.name ?? null,
    metadata_modified: pkg.metadata_modified ?? null,
    formats: dedupFormats(pkg.resources ?? []),
  }));

  return JSON.stringify({ total: result.count ?? datasets.length, datasets }, null, 2);
}

function dedupFormats(resources) {
  const seen = new Set();
  for (const r of resources) {
    const fmt = (r.format ?? "").trim().toUpperCase();
    if (fmt) seen.add(fmt);
  }
  return [...seen];
}
