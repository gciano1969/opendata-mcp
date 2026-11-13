/**
 * get_dataset tool implementation.
 *
 * Fetches full metadata for a single dataset from the dati.gov.it CKAN
 * catalogue by its unique id or slug.
 */

import { ckanGet } from "../ckan.js";

const NOTES_MAX = 500;

/**
 * Retrieve full metadata for a dataset.
 *
 * @param {string} id  Dataset id (UUID) or slug (name)
 * @returns {Promise<string>} JSON string with dataset metadata and resources
 */
export async function getDataset(id) {
  const result = await ckanGet("package_show", { id });

  const notes = result.notes ?? "";
  const truncatedNotes =
    notes.length > NOTES_MAX ? notes.slice(0, NOTES_MAX) + "… [truncated]" : notes;

  const resources = (result.resources ?? []).map((r) => ({
    name: r.name ?? r.id,
    format: (r.format ?? "").toUpperCase() || "unknown",
    url: r.url,
  }));

  const dataset = {
    id: result.id,
    title: result.title ?? result.name,
    notes: truncatedNotes,
    license_title: result.license_title ?? null,
    license_id: result.license_id ?? null,
    license_url: result.license_url ?? null,
    organization: result.organization?.title ?? result.organization?.name ?? null,
    metadata_modified: result.metadata_modified ?? null,
    resources,
  };

  return JSON.stringify(dataset, null, 2);
}
