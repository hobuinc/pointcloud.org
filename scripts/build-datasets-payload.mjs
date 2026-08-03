#!/usr/bin/env node
// Parses one or more manifests/<id>/manifest.yaml files and prints a
// JSON payload of the shape { datasets: [{ datasetId, manifest }, ...] }
// to stdout -- this is the client_payload body for the
// repository_dispatch this repo's .github/workflows/manifest-ingest.yml
// fires at hobuinc/pointcloud.org-infrastructure once a manifest PR
// merges.
//
// This repo intentionally never talks to the ingest Worker directly
// (no WORKER_INGEST_SHARED_SECRET lives here) -- see
// hobuinc/pointcloud.org-infrastructure's
// .github/workflows/receive-manifest-dispatch.yml, which receives this
// payload and forwards it to POST /trigger using that secret.
//
// This is also the ONLY place a manifest's relative file references
// (derivative_processing.{dtm,dsm}.pdal_filters_file, so far -- see
// PLAN.md's "Dataset manifest model") get resolved: this script has a
// real git checkout to read them from, but the Worker never does (see
// worker/src/types.ts's DatasetManifest doc comment) -- by the time a
// manifest reaches POST /trigger, every such reference has already been
// read, parsed, and inlined into the plain field the Worker's type
// actually expects. `metadata_links[].href`'s relative-path form is
// deliberately NOT resolved here -- it's a site-display-only field the
// Worker never reads at all, resolved instead by the site's own build
// (see site/scripts/copy-manifest-metadata.mjs).
//
// Usage: node scripts/build-datasets-payload.mjs <manifest.yaml> [...] > payload.json
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { load as loadYaml } from "js-yaml";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: node scripts/build-datasets-payload.mjs <manifest.yaml> [...]");
  process.exit(1);
}

/**
 * Reads `<manifestDir>/<config.pdal_filters_file>` (if given), parses it
 * as a JSON array of PDAL filter stages, and returns a copy of `config`
 * with `pdal_filters` set from it and `pdal_filters_file` removed --
 * i.e. resolved to the exact shape worker/src/types.ts's
 * DerivativeProcessingConfig expects. Passing both `pdal_filters` and
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

const datasets = files.map((file) => {
  const raw = readFileSync(file, "utf-8");
  const manifest = loadYaml(raw);
  const manifestDir = path.dirname(file);

  if (manifest?.derivative_processing) {
    manifest.derivative_processing = {
      ...manifest.derivative_processing,
      dtm: resolveFilterStages(manifestDir, manifest.derivative_processing.dtm),
      dsm: resolveFilterStages(manifestDir, manifest.derivative_processing.dsm),
    };
  }

  const datasetId = manifest?.dataset?.id ?? path.basename(manifestDir);
  return { datasetId, manifest };
});

process.stdout.write(JSON.stringify({ datasets }));
