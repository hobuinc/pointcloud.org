#!/usr/bin/env node
// Parses one or more manifests/.../<id>/manifest.yaml files and prints a
// JSON payload of the shape
// { datasets: [{ datasetId, group, manifest }, ...] } to stdout -- this
// is the client_payload body for the repository_dispatch this repo's
// .github/workflows/manifest-ingest.yml fires at pointcloud.org's
// private infrastructure once a manifest PR merges.
//
// This repo intentionally never talks to pointcloud.org's ingest
// backend directly (no ingest credentials of any kind live here) --
// the infrastructure side receives this payload and forwards it on to
// its own ingest endpoint using its own credentials.
//
// This is also the ONLY place a manifest's relative file references
// (pointcloud_org.derivative_processing.{dtm,dsm}.pdal_filters_file,
// description's bare-".md"-filename form) get resolved: this script has
// a real git checkout to read them from, but the ingest backend never
// does -- by the time a manifest reaches it, every such reference has
// already been read and inlined into the plain field the ingest backend
// actually expects (description ends up as ordinary Markdown text
// either way, so the STAC Collection this produces carries real
// content, not a meaningless bare filename).
// `pointcloud_org.metadata_links[].href`'s relative-path form is
// deliberately NOT resolved here -- it's a site-display-only field the
// ingest backend never reads at all, resolved instead by the site's own
// build.
//
// `group` (schema_version 2, 2026-08) is derived here from this
// manifest's own directory nesting under manifests/ -- e.g.
// "manifests/usgs-3dep/boston-lot/manifest.yaml" gets group
// "usgs-3dep", while "manifests/autzen/manifest.yaml" (directly under
// manifests/) gets group null. Purely an organizational grouping for
// related datasets (see README.md's "Grouping datasets into
// directories") -- `datasetId` itself is always just the leaf directory
// name regardless of nesting depth, matching every downstream consumer
// (R2 key prefixes, site routes, the STAC catalog, stac-api collection
// ids) that already treats it as a flat, globally-unique string.
//
// Usage: node scripts/build-datasets-payload.mjs <manifest.yaml> [...] > payload.json
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { load as loadYaml } from "js-yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const MANIFESTS_DIR = path.join(REPO_ROOT, "manifests");

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: node scripts/build-datasets-payload.mjs <manifest.yaml> [...]");
  process.exit(1);
}

/**
 * Reads `<manifestDir>/<config.pdal_filters_file>` (if given), parses it
 * as a JSON array of PDAL filter stages, and returns a copy of `config`
 * with `pdal_filters` set from it and `pdal_filters_file` removed --
 * i.e. resolved to the exact shape the ingest backend's
 * DerivativeProcessingConfig type expects. Passing both `pdal_filters` and
 * `pdal_filters_file` on the same block is a validate-manifests.mjs
 * error (mutually exclusive), so this never has to reconcile both being
 * present.
 */
function resolveFilterStages(manifestDir, config) {
  if (!config?.pdal_filters_file) return config;
  const filtersPath = path.join(manifestDir, config.pdal_filters_file);
  const filters = JSON.parse(readFileSync(filtersPath, "utf-8"));
  const { pdal_filters_file, ...rest } = config;
  return { ...rest, pdal_filters: filters };
}

/**
 * If `description` is a bare relative filename ending in ".md" (see
 * schema.json's description of this field, and
 * validate-manifests.mjs's matching check), reads that file's content
 * from `manifestDir` and returns it in its place. Otherwise returns
 * `description` unchanged (inline text, or absent). Same
 * read-and-inline treatment as resolveFilterStages() above, for the
 * same reason: the ingest backend has no git checkout of this repo to
 * resolve a relative path against.
 */
function resolveDescription(manifestDir, description) {
  if (typeof description !== "string" || !/^[^\s]+\.md$/i.test(description)) return description;
  return readFileSync(path.join(manifestDir, description), "utf-8");
}

/**
 * "manifests/usgs-3dep/boston-lot" -> "usgs-3dep"; "manifests/autzen" ->
 * null. See this module's doc comment.
 */
function groupFromManifestDir(manifestDir) {
  const rel = path.relative(MANIFESTS_DIR, manifestDir);
  const segments = rel.split(path.sep);
  return segments.length > 1 ? segments.slice(0, -1).join("/") : null;
}

const datasets = files.map((file) => {
  const raw = readFileSync(file, "utf-8");
  const manifest = loadYaml(raw);
  const manifestDir = path.dirname(file);

  if (manifest?.pointcloud_org?.derivative_processing) {
    manifest.pointcloud_org = {
      ...manifest.pointcloud_org,
      derivative_processing: {
        ...manifest.pointcloud_org.derivative_processing,
        dtm: resolveFilterStages(manifestDir, manifest.pointcloud_org.derivative_processing.dtm),
        dsm: resolveFilterStages(manifestDir, manifest.pointcloud_org.derivative_processing.dsm),
      },
    };
  }

  manifest.description = resolveDescription(manifestDir, manifest.description);

  const datasetId = manifest?.id ?? path.basename(manifestDir);
  const group = groupFromManifestDir(manifestDir);
  return { datasetId, group, manifest };
});

process.stdout.write(JSON.stringify({ datasets }));
