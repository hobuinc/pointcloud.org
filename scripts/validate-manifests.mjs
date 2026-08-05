#!/usr/bin/env node
// Validates manifests/.../<id>/manifest.yaml file(s) against
// manifests/schema.json -- the single source of truth for the manifest
// format, see that file's own $id/description. Run in CI by
// .github/workflows/manifest-ingest.yml's `validate` job on every PR
// touching manifests/; exits non-zero on any failure so the workflow
// step fails the check.
//
// schema_version 2 (2026-08) allows a dataset's manifest.yaml to live at
// any depth under manifests/, not just manifests/<id>/ -- e.g.
// manifests/usgs-3dep/boston-lot/manifest.yaml -- purely so related
// datasets can be organized under a named directory (which becomes a
// `pointcloud_org:group` property on the assembled STAC Collection; see
// README.md's "Grouping datasets into directories"). `dataset id` is
// still always just the manifest's own (leaf) directory name, and must
// still be globally unique across the whole repo regardless of nesting
// -- enforced below, since the filesystem alone no longer guarantees it
// once more than one directory can share a leaf name.
//
// Usage:
//   node scripts/validate-manifests.mjs
//     No arguments -- validates every manifest.yaml found anywhere
//     under manifests/. This is what running it locally, or a PR that
//     only touches manifests/schema.json itself, should use (a schema
//     change can break a dataset it didn't directly touch).
//   node scripts/validate-manifests.mjs manifests/.../<id>/manifest.yaml
//     Exactly one path -- validates only that dataset. This is what CI
//     actually passes for a normal PR (see the `validate` job, which
//     forwards the `changed` job's `manifest_files` output): a PR that
//     only touched one dataset directory has no reason to re-validate
//     the rest.
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
// need real filesystem access to this manifest's own directory, or
// cross-manifest knowledge) and are layered on top of the ajv/schema.json
// check below, not encoded in schema.json itself:
//   - pointcloud_org.metadata_links[].href's relative-path form must
//     point at a file that actually exists alongside manifest.yaml.
//   - pointcloud_org.derivative_processing.{dtm,dsm}.pdal_filters_file
//     must point at a file that exists, and that file must actually
//     parse as a JSON array of {type: string, ...} objects.
//   - dataset id must be globally unique across every manifest in the
//     repo, not just unique among siblings (only checkable with a full,
//     no-arguments run -- see checkGlobalIdUniqueness() below).
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
  const pco = manifest?.pointcloud_org ?? {};
  const providerCount = Array.isArray(manifest?.providers) ? manifest.providers.length : 0;
  const keywordCount = Array.isArray(manifest?.keywords) ? manifest.keywords.length : 0;
  const metadataLinkCount = Array.isArray(pco.metadata_links) ? pco.metadata_links.length : 0;

  let kind = "(none of items/items_dir/stac_item/external_source/ept_source)";
  if (Array.isArray(manifest?.items)) {
    kind = `items (${manifest.items.length} hand-authored entr${manifest.items.length === 1 ? "y" : "ies"})`;
  } else if (manifest?.items_dir) {
    kind = `items_dir (expanded at ingest time; pattern ${manifest.items_dir.pattern ?? "*.copc.laz (default)"})`;
  } else if (manifest?.stac_item) {
    kind = `stac_item (references ${manifest.stac_item.href})`;
  } else if (manifest?.external_source) {
    kind = `external_source (dry-run only today; expand=${Boolean(manifest.external_source.expand)})`;
  } else if (manifest?.ept_source) {
    kind = `ept_source (references ${manifest.ept_source.href})`;
  }

  const derivativeBits = [];
  if (pco.derivative_processing) {
    for (const key of ["dtm", "dsm", "ambient_occlusion"]) {
      const cfg = pco.derivative_processing[key];
      if (cfg?.enabled) derivativeBits.push(key);
    }
    if (pco.derivative_processing.dtm?.pdal_filters_file) {
      derivativeBits.push(`dtm.pdal_filters_file=${pco.derivative_processing.dtm.pdal_filters_file}`);
    }
    if (pco.derivative_processing.dsm?.pdal_filters_file) {
      derivativeBits.push(`dsm.pdal_filters_file=${pco.derivative_processing.dsm.pdal_filters_file}`);
    }
  }

  const bits = [
    kind,
    `${providerCount} provider(s)`,
    `${keywordCount} keyword(s)`,
    metadataLinkCount > 0 ? `${metadataLinkCount} metadata_link(s)` : null,
    pco.default_endpoint ? `default_endpoint=${pco.default_endpoint}` : null,
    manifest?.assets?.thumbnail ? "thumbnail asset set" : null,
    manifest?.["sci:citation"] ? "sci:citation set" : null,
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
  const pco = manifest?.pointcloud_org ?? {};

  // description may be a bare relative filename ending in ".md" (e.g.
  // "description.md") instead of inline text -- see schema.json's
  // description of this field. A simple filename-shaped pattern (no
  // whitespace, ends in .md) is enough to distinguish "this is a file
  // reference" from "this is inline Markdown that happens to mention a
  // .md file", since inline prose containing whitespace never matches
  // it.
  const description = manifest?.description;
  const isDescriptionFileRef = typeof description === "string" && /^[^\s]+\.md$/i.test(description);
  if (description === undefined) {
    log("no description -- nothing to check");
  } else if (isDescriptionFileRef) {
    const target = path.join(manifestDir, description);
    const rel = path.relative(REPO_ROOT, target);
    if (!existsSync(target)) {
      log(`  description "${description}" -> ${rel}: MISSING`);
      errors.push(`description "${description}" looks like a relative Markdown file reference but does not exist at ${rel}`);
    } else {
      log(`  description "${description}" -> ${rel}: exists`);
    }
  } else {
    log("description is inline text, not a file reference -- nothing to check");
  }

  const metadataLinks = pco.metadata_links ?? [];
  const relativeLinks = metadataLinks.filter((link) => link?.href && !/^https?:\/\//.test(link.href));
  if (metadataLinks.length === 0) {
    log("no pointcloud_org.metadata_links -- nothing to check");
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
      errors.push(`pointcloud_org.metadata_links[${i}].href "${link.href}" does not exist at ${rel}`);
    } else {
      log(`  metadata_links[${i}] "${link.href}" -> ${rel}: exists`);
    }
  }

  let filtersFileCount = 0;
  for (const key of ["dtm", "dsm"]) {
    const filtersFile = pco.derivative_processing?.[key]?.pdal_filters_file;
    if (!filtersFile) continue;
    filtersFileCount += 1;
    const target = path.join(manifestDir, filtersFile);
    const rel = path.relative(REPO_ROOT, target);
    if (!existsSync(target)) {
      log(`  derivative_processing.${key}.pdal_filters_file "${filtersFile}" -> ${rel}: MISSING`);
      errors.push(`pointcloud_org.derivative_processing.${key}.pdal_filters_file "${filtersFile}" does not exist at ${rel}`);
      continue;
    }
    try {
      const parsed = JSON.parse(readFileSync(target, "utf-8"));
      if (!Array.isArray(parsed) || !parsed.every((stage) => stage && typeof stage === "object" && typeof stage.type === "string")) {
        log(`  derivative_processing.${key}.pdal_filters_file "${filtersFile}" -> ${rel}: exists, but not a valid filter-stage array`);
        errors.push(`pointcloud_org.derivative_processing.${key}.pdal_filters_file "${filtersFile}" must be a JSON array of {"type": "...", ...} filter stage objects`);
      } else {
        log(`  derivative_processing.${key}.pdal_filters_file "${filtersFile}" -> ${rel}: exists, ${parsed.length} filter stage(s) (${parsed.map((s) => s.type).join(", ")})`);
      }
    } catch (err) {
      log(`  derivative_processing.${key}.pdal_filters_file "${filtersFile}" -> ${rel}: exists, but failed to parse as JSON -- ${err.message}`);
      errors.push(`pointcloud_org.derivative_processing.${key}.pdal_filters_file "${filtersFile}" is not valid JSON -- ${err.message}`);
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

  // id must match the manifest's own (leaf) directory name -- not
  // expressible in schema.json (it doesn't know the filesystem), but
  // load-bearing: both the ingest backend and the site build resolve
  // routes and relative-path references off the directory name, not
  // this field. datasetDir may itself be a multi-segment path now (a
  // grouped dataset, e.g. "usgs-3dep/boston-lot") -- only the leaf
  // segment (path.basename) has to match id; the rest is purely a
  // grouping directory, not part of the id (see README.md's "Grouping
  // datasets into directories").
  const leafName = path.basename(datasetDir);
  log(`checking id ("${normalized?.id}") matches leaf directory name ("${leafName}")...`);
  if (normalized?.id && normalized.id !== leafName) {
    log("id mismatch");
    errors.push(`id "${normalized.id}" does not match its directory name "manifests/${datasetDir}/" (expected "${leafName}")`);
  } else {
    log("id matches");
  }

  if (errors.length > 0) {
    console.error(`FAIL ${datasetDir}/manifest.yaml:`);
    for (const e of errors) console.error(`  - ${e}`);
    return false;
  }
  console.log(`ok   ${datasetDir}`);
  return { ok: true, id: normalized?.id ?? leafName, datasetDir };
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
  // At least 2 segments ("<dir>/manifest.yaml"); any depth is allowed
  // now (grouping directories, see this module's doc comment) -- only
  // the last segment must literally be "manifest.yaml" and every
  // segment must stay inside manifests/.
  if (segments.length < 2 || segments[segments.length - 1] !== "manifest.yaml" || segments[0].startsWith("..")) {
    throw new Error(`expected a path of the form "manifests/.../<id>/manifest.yaml", got "${arg}"`);
  }
  return segments.slice(0, -1).join("/");
}

/**
 * Recursively finds every manifest.yaml under `dir`, returning dataset
 * directory paths relative to MANIFESTS_DIR (e.g. "autzen" or
 * "usgs-3dep/boston-lot"). Does NOT descend into a directory once it's
 * found a manifest.yaml directly inside it -- a dataset directory is a
 * leaf as far as manifest discovery goes, so this also implicitly
 * forbids one dataset's directory containing another's.
 */
function findManifestDirs(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    const entryPath = path.join(dir, entry);
    if (!statSync(entryPath).isDirectory()) continue;
    if (existsSync(path.join(entryPath, "manifest.yaml"))) {
      found.push(path.relative(MANIFESTS_DIR, entryPath).split(path.sep).join("/"));
    } else {
      found.push(...findManifestDirs(entryPath));
    }
  }
  return found;
}

/**
 * dataset ids must be unique across the ENTIRE repo, not just among
 * siblings -- the filesystem alone no longer guarantees this now that
 * grouping directories exist (two different groups could each contain a
 * "boston-lot"), and every downstream consumer (R2 key prefixes, site
 * routes, the STAC catalog, stac-api collection ids) treats id as a
 * flat, globally-unique string. Only meaningful on a full (no-argument)
 * run -- a single-dataset CI run has no way to see every other id.
 */
function checkGlobalIdUniqueness(results) {
  const byId = new Map();
  for (const { id, datasetDir } of results) {
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(datasetDir);
  }
  const errors = [];
  for (const [id, dirs] of byId) {
    if (dirs.length > 1) {
      errors.push(`id "${id}" is used by ${dirs.length} different manifests: ${dirs.map((d) => `manifests/${d}/`).join(", ")}`);
    }
  }
  return errors;
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
  let checkingEverything = false;
  if (args.length === 1) {
    datasetDirs = [datasetDirFromArg(args[0])];
    console.log(`[validate] validating 1 dataset given on the command line: ${datasetDirs[0]}`);
  } else {
    checkingEverything = true;
    datasetDirs = findManifestDirs(MANIFESTS_DIR).sort();
    console.log(`[validate] no path given -- recursively found ${datasetDirs.length} manifest.yaml file(s) under manifests/`);
    console.log(`[validate] dataset directories: ${datasetDirs.join(", ")}`);
  }
  console.log("");

  let okCount = 0;
  let failCount = 0;
  const passedResults = [];
  for (const [index, datasetDir] of datasetDirs.entries()) {
    const result = validateOneDataset(datasetDir, index, datasetDirs.length);
    if (result) {
      okCount += 1;
      passedResults.push(result);
    } else {
      failCount += 1;
    }
    console.log("");
  }

  if (checkingEverything) {
    console.log("[validate] checking global id uniqueness across every dataset...");
    const idErrors = checkGlobalIdUniqueness(passedResults);
    if (idErrors.length > 0) {
      console.error("FAIL: duplicate dataset id(s) found:");
      for (const e of idErrors) console.error(`  - ${e}`);
      failCount += idErrors.length;
    } else {
      console.log("[validate] all ids globally unique");
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
