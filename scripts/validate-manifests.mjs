#!/usr/bin/env node
// Validates manifests/<id>/manifest.yaml file(s) against
// manifests/schema.json -- the single source of truth for the manifest
// format, see that file's own $id/description. Run in CI by
// .github/workflows/manifest-ingest.yml's `validate` job on every PR
// touching manifests/; exits non-zero on any failure so the workflow
// step fails the check.
//
// Usage:
//   node scripts/validate-manifests.mjs
//     No arguments -- validates every manifests/<id>/manifest.yaml in
//     the repo. This is what running it locally, or a PR that only
//     touches manifests/schema.json itself, should use (a schema
//     change can break a dataset it didn't directly touch).
//   node scripts/validate-manifests.mjs manifests/<id>/manifest.yaml
//     Exactly one path -- validates only that dataset. This is what CI
//     actually passes for a normal PR (see the `validate` job, which
//     forwards the `changed` job's `manifest_files` output): a PR that
//     only touched one dataset directory has no reason to re-validate
//     the other 18+.
//   node scripts/validate-manifests.mjs manifests/a/manifest.yaml manifests/b/manifest.yaml
//     More than one path -- refuses outright (see REJECT_MULTIPLE
//     below). One PR is only ever allowed to touch one dataset
//     directory, so this shape means the PR itself needs splitting up,
//     not that this script should try to validate multiple datasets at
//     once. The workflow also posts a comment explaining this on the
//     PR itself (see .github/workflows/manifest-ingest.yml's
//     `reject-multi-dataset-pr` job) -- this script's job is just to
//     fail loudly and unambiguously, in CI logs and for anyone running
//     it locally.
//
// This is schema/presence validation only -- it does NOT check the
// actual point-cloud data (CRS consistency, file existence, etc.).
// That happens later, against pointcloud.org's real infrastructure --
// see manifests/README.md's "How ingest actually happens".
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
//
// Logging is intentionally verbose (2026-08-03) -- every check for every
// dataset gets its own line, not just failures. A CI log that only ever
// shows failures makes it hard to tell "the good case ran and passed"
// apart from "this step didn't run at all"; being loud about what
// passed removes that ambiguity, and gives a contributor opening their
// own PR's Actions log a step-by-step account of what their manifest
// was actually checked against, not just a final ok/FAIL.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import { load as loadYaml } from "js-yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const MANIFESTS_DIR = path.join(REPO_ROOT, "manifests");
const SCHEMA_PATH = path.join(MANIFESTS_DIR, "schema.json");

console.log(`[validate] schema: ${path.relative(REPO_ROOT, SCHEMA_PATH)}`);
const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf-8"));
console.log(`[validate] schema $id: ${schema.$id ?? "(none)"}`);

const ajv = new Ajv({ allErrors: true, strict: false });
const validateSchema = ajv.compile(schema);
console.log("[validate] ajv: schema compiled ok");

/**
 * One-line human summary of a parsed (and Date-normalized) manifest's
 * shape, logged right after parsing so a reader can sanity-check "does
 * this look like what I expect" before the schema/reference checks run.
 */
function describeManifest(manifest) {
  const ds = manifest?.dataset ?? {};
  const providerCount = Array.isArray(ds.providers) ? ds.providers.length : 0;
  const tagCount = Array.isArray(ds.tags) ? ds.tags.length : 0;
  const metadataLinkCount = Array.isArray(ds.metadata_links) ? ds.metadata_links.length : 0;

  let kind = "(none of assets/assets_dir/external_source)";
  if (Array.isArray(manifest?.assets)) {
    kind = `assets (${manifest.assets.length} hand-authored entr${manifest.assets.length === 1 ? "y" : "ies"})`;
  } else if (manifest?.assets_dir) {
    kind = `assets_dir (expanded at ingest time; pattern ${manifest.assets_dir.pattern ?? "*.copc.laz (default)"})`;
  } else if (manifest?.external_source) {
    kind = `external_source (dry-run only today; expand=${Boolean(manifest.external_source.expand)})`;
  }

  const derivativeBits = [];
  if (manifest?.derivative_processing) {
    for (const key of ["dtm", "dsm", "ambient_occlusion"]) {
      const cfg = manifest.derivative_processing[key];
      if (cfg?.enabled) derivativeBits.push(key);
    }
    if (manifest.derivative_processing.dtm?.pdal_filters_file) {
      derivativeBits.push(`dtm.pdal_filters_file=${manifest.derivative_processing.dtm.pdal_filters_file}`);
    }
    if (manifest.derivative_processing.dsm?.pdal_filters_file) {
      derivativeBits.push(`dsm.pdal_filters_file=${manifest.derivative_processing.dsm.pdal_filters_file}`);
    }
  }

  const bits = [
    kind,
    `${providerCount} provider(s)`,
    `${tagCount} tag(s)`,
    metadataLinkCount > 0 ? `${metadataLinkCount} metadata_link(s)` : null,
    ds.default_endpoint ? `default_endpoint=${ds.default_endpoint}` : null,
    ds.overview_image ? "overview_image set" : null,
    derivativeBits.length > 0 ? `derivative_processing: ${derivativeBits.join(", ")}` : null,
  ].filter(Boolean);

  return bits.join("; ");
}

/**
 * Checks the handful of things schema.json can't express -- see this
 * module's doc comment. `manifestDir` is this manifest's own directory
 * (manifests/<id>/), the base relative paths resolve against.
 */
function validateLocalReferences(manifestDir, manifest, log) {
  const errors = [];

  const metadataLinks = manifest?.dataset?.metadata_links ?? [];
  const relativeLinks = metadataLinks.filter((link) => link?.href && !/^https?:\/\//.test(link.href));
  if (metadataLinks.length === 0) {
    log("no metadata_links -- nothing to check");
  } else {
    log(
      `${metadataLinks.length} metadata_link(s), ${relativeLinks.length} relative (${metadataLinks.length - relativeLinks.length} remote, skipped)`,
    );
  }
  for (const [i, link] of metadataLinks.entries()) {
    if (!link?.href || /^https?:\/\//.test(link.href)) continue;
    const target = path.join(manifestDir, link.href);
    const rel = path.relative(REPO_ROOT, target);
    if (!existsSync(target)) {
      log(`  metadata_links[${i}] "${link.href}" -> ${rel}: MISSING`);
      errors.push(`dataset.metadata_links[${i}].href "${link.href}" does not exist at ${rel}`);
    } else {
      log(`  metadata_links[${i}] "${link.href}" -> ${rel}: exists`);
    }
  }

  let filtersFileCount = 0;
  for (const key of ["dtm", "dsm"]) {
    const filtersFile = manifest?.derivative_processing?.[key]?.pdal_filters_file;
    if (!filtersFile) continue;
    filtersFileCount += 1;
    const target = path.join(manifestDir, filtersFile);
    const rel = path.relative(REPO_ROOT, target);
    if (!existsSync(target)) {
      log(`  derivative_processing.${key}.pdal_filters_file "${filtersFile}" -> ${rel}: MISSING`);
      errors.push(`derivative_processing.${key}.pdal_filters_file "${filtersFile}" does not exist at ${rel}`);
      continue;
    }
    try {
      const parsed = JSON.parse(readFileSync(target, "utf-8"));
      if (!Array.isArray(parsed) || !parsed.every((stage) => stage && typeof stage === "object" && typeof stage.type === "string")) {
        log(`  derivative_processing.${key}.pdal_filters_file "${filtersFile}" -> ${rel}: exists, but not a valid filter-stage array`);
        errors.push(`derivative_processing.${key}.pdal_filters_file "${filtersFile}" must be a JSON array of {"type": "...", ...} filter stage objects`);
      } else {
        log(`  derivative_processing.${key}.pdal_filters_file "${filtersFile}" -> ${rel}: exists, ${parsed.length} filter stage(s) (${parsed.map((s) => s.type).join(", ")})`);
      }
    } catch (err) {
      log(`  derivative_processing.${key}.pdal_filters_file "${filtersFile}" -> ${rel}: exists, but failed to parse as JSON -- ${err.message}`);
      errors.push(`derivative_processing.${key}.pdal_filters_file "${filtersFile}" is not valid JSON -- ${err.message}`);
    }
  }
  if (filtersFileCount === 0) {
    log("no pdal_filters_file references -- nothing to check");
  }

  return errors;
}

/**
 * Validates one manifests/<datasetDir>/manifest.yaml. `label` is a
 * short "(i/total)" prefix for the log lines; `total` of 1 omits it.
 * Returns true if it passed, false if it failed (already logged either
 * way).
 */
function validateOneDataset(datasetDir, index, total) {
  const prefix = total > 1 ? `(${index + 1}/${total}) ${datasetDir}` : datasetDir;
  const log = (msg) => console.log(`[validate] ${prefix}: ${msg}`);

  const manifestPath = path.join(MANIFESTS_DIR, datasetDir, "manifest.yaml");
  log(`reading ${path.relative(REPO_ROOT, manifestPath)}`);
  if (!existsSync(manifestPath)) {
    console.error(`FAIL ${datasetDir}/: no manifest.yaml found in this directory`);
    return false;
  }

  const raw = readFileSync(manifestPath, "utf-8");
  log(`read ${raw.length} byte(s) of YAML`);
  let manifest;
  try {
    manifest = loadYaml(raw);
  } catch (err) {
    console.error(`FAIL ${datasetDir}/manifest.yaml: invalid YAML -- ${err.message}`);
    return false;
  }
  log("YAML parsed ok");
  log(describeManifest(manifest));

  // js-yaml parses unquoted YAML dates (e.g. "2020-03-01") as JS Date
  // objects, not strings -- this round-trip normalizes them to ISO
  // strings via JSON.stringify's default Date behavior, matching the
  // real on-the-wire shape build-datasets-payload.mjs actually sends
  // downstream (which only ever sees JSON, never a live Date instance)
  // -- without this, every manifest with an unquoted temporal.start/end
  // or publication_date would fail schema.json's `type: string` checks
  // even though the real payload is fine.
  const normalized = JSON.parse(JSON.stringify(manifest ?? null));
  log("normalized Date fields (temporal.start/end, publication_date) to ISO strings for schema check");

  const errors = [];

  log("running ajv schema validation against schema.json...");
  if (!validateSchema(normalized)) {
    log(`ajv: ${validateSchema.errors.length} error(s)`);
    for (const e of validateSchema.errors) {
      errors.push(`${e.instancePath || "(root)"} ${e.message}`);
    }
  } else {
    log("ajv: schema validation passed");
  }

  log("checking local file references (metadata_links, pdal_filters_file)...");
  errors.push(...validateLocalReferences(path.join(MANIFESTS_DIR, datasetDir), normalized, log));

  // dataset.id must match the directory name -- not expressible in
  // schema.json (it doesn't know the filesystem), but load-bearing:
  // both the ingest backend and the site build resolve routes and
  // relative-path references off the directory name, not dataset.id.
  log(`checking dataset.id ("${normalized?.dataset?.id}") matches directory name ("${datasetDir}")...`);
  if (normalized?.dataset?.id && normalized.dataset.id !== datasetDir) {
    log("id mismatch");
    errors.push(`dataset.id "${normalized.dataset.id}" does not match its directory name "manifests/${datasetDir}/"`);
  } else {
    log("id matches");
  }

  if (errors.length > 0) {
    console.error(`FAIL ${datasetDir}/manifest.yaml:`);
    for (const e of errors) console.error(`  - ${e}`);
    return false;
  }
  console.log(`ok   ${datasetDir}`);
  return true;
}

/**
 * Turns a CLI argument (e.g. "manifests/autzen/manifest.yaml") into its
 * dataset directory name ("autzen"). Deliberately strict: this script
 * is always invoked either with no arguments, or with path(s) built by
 * .github/workflows/manifest-ingest.yml's `changed` job in exactly this
 * shape, so any other shape indicates something is wrong upstream and
 * should fail loudly rather than silently mis-resolve.
 */
function datasetDirFromArg(arg) {
  const rel = path.relative(MANIFESTS_DIR, path.resolve(REPO_ROOT, arg));
  const segments = rel.split(path.sep);
  if (segments.length !== 2 || segments[1] !== "manifest.yaml" || segments[0].startsWith("..")) {
    throw new Error(`expected a path of the form "manifests/<id>/manifest.yaml", got "${arg}"`);
  }
  return segments[0];
}

function main() {
  const startedAt = Date.now();
  const args = process.argv.slice(2);

  // One PR is only ever allowed to touch one dataset directory (see
  // this module's doc comment) -- refuse outright rather than trying
  // to validate several at once. The workflow's `changed` job is what
  // actually decides "too many" from real PR file changes; this is a
  // second, script-level guard so the same rule holds for anyone
  // invoking this script directly (locally, or from a different CI
  // path) with more than one manifest path.
  if (args.length > 1) {
    const ids = args.map((a) => {
      try {
        return datasetDirFromArg(a);
      } catch {
        return a;
      }
    });
    console.error(`FAIL: this PR touches ${args.length} dataset directories (${ids.join(", ")}).`);
    console.error("Each pull request may only add or edit ONE dataset directory under manifests/.");
    console.error(`Please close this PR and resubmit as ${args.length} separate pull requests, one per dataset.`);
    process.exit(1);
  }

  let datasetDirs;
  if (args.length === 1) {
    datasetDirs = [datasetDirFromArg(args[0])];
    console.log(`[validate] validating 1 dataset given on the command line: ${datasetDirs[0]}`);
  } else {
    const entries = readdirSync(MANIFESTS_DIR);
    console.log(`[validate] no path given -- validating every dataset. Found ${entries.length} entr(y/ies) directly under manifests/: ${entries.join(", ")}`);
    datasetDirs = entries.filter((entry) => statSync(path.join(MANIFESTS_DIR, entry)).isDirectory());
    console.log(
      `[validate] ${datasetDirs.length} of those are directories (dataset candidates), ${entries.length - datasetDirs.length} are top-level files (e.g. schema.json, README.md) and are skipped here`,
    );
    console.log(`[validate] dataset directories: ${datasetDirs.join(", ")}`);
  }
  console.log("");

  let okCount = 0;
  let failCount = 0;
  for (const [index, datasetDir] of datasetDirs.entries()) {
    if (validateOneDataset(datasetDir, index, datasetDirs.length)) {
      okCount += 1;
    } else {
      failCount += 1;
    }
    console.log("");
  }

  const elapsedMs = Date.now() - startedAt;
  console.log(`[validate] ${okCount} ok, ${failCount} failed, out of ${datasetDirs.length} dataset(s), in ${elapsedMs}ms`);

  if (failCount > 0) {
    console.error("\nOne or more manifests failed validation.");
    process.exit(1);
  }
  console.log(`\nAll ${datasetDirs.length} manifest(s) valid.`);
}

main();
