#!/usr/bin/env node
// Validates every manifests/<id>/manifest.yaml against manifests/schema.json
// -- the single source of truth for the manifest format, see that file's
// own $id/description and PLAN.md's "Dataset manifest model". Run in CI
// by .github/workflows/manifest-ingest.yml on every PR touching
// manifests/ (and can be run locally the same way: `node
// scripts/validate-manifests.mjs`); exits non-zero on any failure so the
// workflow step fails the check.
//
// This is schema/presence validation only -- it does NOT check the
// actual point-cloud data (CRS consistency, file existence, etc.). That
// happens at ingest time, in the Worker, via directoryPreflight.ts (for
// `assets_dir` manifests) once /trigger is called.
//
// A handful of checks genuinely can't be expressed in JSON Schema (they
// need real filesystem access to this manifest's own directory) and are
// layered on top of the ajv/schema.json check below, not encoded in
// schema.json itself:
//   - metadata_links[].href's relative-path form must point at a file
//     that actually exists alongside manifest.yaml.
//   - derivative_processing.{dtm,dsm}.pdal_filters_file must point at a
//     file that exists, and that file must actually parse as a JSON
//     array of {type: string, ...} objects.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import { load as loadYaml } from "js-yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const MANIFESTS_DIR = path.join(REPO_ROOT, "manifests");

const schema = JSON.parse(readFileSync(path.join(MANIFESTS_DIR, "schema.json"), "utf-8"));
const ajv = new Ajv({ allErrors: true, strict: false });
const validateSchema = ajv.compile(schema);

/**
 * Checks the handful of things schema.json can't express -- see this
 * module's doc comment. `manifestDir` is this manifest's own directory
 * (manifests/<id>/), the base relative paths resolve against.
 */
function validateLocalReferences(manifestDir, manifest) {
  const errors = [];

  for (const [i, link] of (manifest?.dataset?.metadata_links ?? []).entries()) {
    if (!link?.href || /^https?:\/\//.test(link.href)) continue;
    const target = path.join(manifestDir, link.href);
    if (!existsSync(target)) {
      errors.push(`dataset.metadata_links[${i}].href "${link.href}" does not exist at ${path.relative(REPO_ROOT, target)}`);
    }
  }

  for (const key of ["dtm", "dsm"]) {
    const filtersFile = manifest?.derivative_processing?.[key]?.pdal_filters_file;
    if (!filtersFile) continue;
    const target = path.join(manifestDir, filtersFile);
    if (!existsSync(target)) {
      errors.push(`derivative_processing.${key}.pdal_filters_file "${filtersFile}" does not exist at ${path.relative(REPO_ROOT, target)}`);
      continue;
    }
    try {
      const parsed = JSON.parse(readFileSync(target, "utf-8"));
      if (!Array.isArray(parsed) || !parsed.every((stage) => stage && typeof stage === "object" && typeof stage.type === "string")) {
        errors.push(`derivative_processing.${key}.pdal_filters_file "${filtersFile}" must be a JSON array of {"type": "...", ...} filter stage objects`);
      }
    } catch (err) {
      errors.push(`derivative_processing.${key}.pdal_filters_file "${filtersFile}" is not valid JSON -- ${err.message}`);
    }
  }

  return errors;
}

function main() {
  const datasetDirs = readdirSync(MANIFESTS_DIR).filter((entry) =>
    statSync(path.join(MANIFESTS_DIR, entry)).isDirectory(),
  );
  let failed = false;

  for (const datasetDir of datasetDirs) {
    const manifestPath = path.join(MANIFESTS_DIR, datasetDir, "manifest.yaml");
    if (!existsSync(manifestPath)) {
      console.error(`FAIL ${datasetDir}/: no manifest.yaml found in this directory`);
      failed = true;
      continue;
    }

    const raw = readFileSync(manifestPath, "utf-8");
    let manifest;
    try {
      manifest = loadYaml(raw);
    } catch (err) {
      console.error(`FAIL ${datasetDir}/manifest.yaml: invalid YAML -- ${err.message}`);
      failed = true;
      continue;
    }

    // js-yaml parses unquoted YAML dates (e.g. "2020-03-01") as JS Date
    // objects, not strings -- this round-trip normalizes them to ISO
    // strings via JSON.stringify's default Date behavior, matching the
    // real on-the-wire shape build-datasets-payload.mjs actually sends
    // to the Worker (which only ever sees JSON, never a live Date
    // instance) -- without this, every manifest with an unquoted
    // temporal.start/end or publication_date would fail schema.json's
    // `type: string` checks even though the real payload is fine.
    const normalized = JSON.parse(JSON.stringify(manifest ?? null));

    const errors = [];
    if (!validateSchema(normalized)) {
      for (const e of validateSchema.errors) {
        errors.push(`${e.instancePath || "(root)"} ${e.message}`);
      }
    }
    errors.push(...validateLocalReferences(path.join(MANIFESTS_DIR, datasetDir), normalized));

    // dataset.id must match the directory name -- not expressible in
    // schema.json (it doesn't know the filesystem), but load-bearing:
    // site/src/lib/manifests.ts, build-datasets-payload.mjs, and
    // scripts/copy-manifest-metadata.mjs all resolve relative paths and
    // routes off the directory name, not dataset.id.
    if (normalized?.dataset?.id && normalized.dataset.id !== datasetDir) {
      errors.push(`dataset.id "${normalized.dataset.id}" does not match its directory name "manifests/${datasetDir}/"`);
    }

    if (errors.length > 0) {
      failed = true;
      console.error(`FAIL ${datasetDir}/manifest.yaml:`);
      for (const e of errors) console.error(`  - ${e}`);
    } else {
      console.log(`ok   ${datasetDir}`);
    }
  }

  if (failed) {
    console.error("\nOne or more manifests failed validation.");
    process.exit(1);
  }
  console.log(`\nAll ${datasetDirs.length} manifest(s) valid.`);
}

main();
