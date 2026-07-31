#!/usr/bin/env node
// Validates every manifests/*.yaml against the required-field rules
// documented in PLAN.md's "Dataset manifest model" section and mirrored
// in worker/src/types.ts's DatasetManifest type. Run in CI by
// .github/workflows/manifest-ingest.yml on every PR touching
// manifests/*.yaml (and can be run locally the same way: `node
// scripts/validate-manifests.mjs`); exits non-zero on any failure so the
// workflow step fails the check.
//
// This is schema/presence validation only -- it does NOT check the
// actual point-cloud data (CRS consistency, file existence, etc.). That
// happens at ingest time, in the Worker, via directoryPreflight.ts (for
// `assets_dir` manifests) once /trigger is called.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { load as loadYaml } from "js-yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MANIFESTS_DIR = path.join(__dirname, "..", "manifests");

/** Returns a list of human-readable problems with one manifest -- empty array means valid. */
function validateManifest(file, manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== "object") {
    return [`is empty or not a YAML mapping`];
  }
  if (manifest.schema_version !== 1) {
    errors.push(`schema_version must be 1 (got ${JSON.stringify(manifest.schema_version)})`);
  }

  const dataset = manifest.dataset;
  if (!dataset || typeof dataset !== "object") {
    errors.push(`missing "dataset" section`);
    return errors; // nothing further to check without it
  }

  if (!dataset.id || typeof dataset.id !== "string") errors.push(`dataset.id is required`);
  if (!dataset.title || typeof dataset.title !== "string") errors.push(`dataset.title is required`);

  // Required per Howard, 2026-07-31: license, at least one tag, and a
  // summary must all be present (non-empty) -- "UNKNOWN" and
  // "TODO: ..." placeholder text are both accepted as *present*; this
  // check only catches a field that's missing or blank, it doesn't
  // second-guess the placeholder convention used throughout
  // manifests/*.yaml today for datasets whose real license/summary
  // hasn't been confirmed yet.
  if (!dataset.summary || typeof dataset.summary !== "string" || dataset.summary.trim() === "") {
    errors.push(`dataset.summary is required and must be non-empty`);
  }
  if (!dataset.license || typeof dataset.license !== "string" || dataset.license.trim() === "") {
    errors.push(`dataset.license is required and must be non-empty`);
  }
  if (!Array.isArray(dataset.tags) || dataset.tags.length === 0) {
    errors.push(`dataset.tags must be a non-empty array (at least one tag)`);
  }

  // Required per Howard, 2026-07-31: every manifest must name a
  // maintainer to notify if this dataset's ingest preflight fails (see
  // worker/src/email.ts and directoryPreflight.ts).
  const maintainer = dataset.maintainer;
  if (!maintainer || typeof maintainer !== "object") {
    errors.push(`dataset.maintainer is required (must have "name" and "email")`);
  } else {
    if (!maintainer.name || typeof maintainer.name !== "string") {
      errors.push(`dataset.maintainer.name is required`);
    }
    if (!maintainer.email || typeof maintainer.email !== "string" || !maintainer.email.includes("@")) {
      errors.push(`dataset.maintainer.email is required and must look like an email address`);
    }
  }

  if (typeof dataset.derivatives !== "boolean") {
    errors.push(`dataset.derivatives is required and must be true/false`);
  }

  const hasAssets = Array.isArray(manifest.assets) && manifest.assets.length > 0;
  const hasAssetsDir = manifest.assets_dir && typeof manifest.assets_dir === "object";
  if (hasAssets && hasAssetsDir) {
    errors.push(`manifest has both "assets" and "assets_dir" -- exactly one is allowed`);
  } else if (!hasAssets && !hasAssetsDir) {
    errors.push(`manifest must have a non-empty "assets" array or an "assets_dir" block`);
  } else if (hasAssets) {
    manifest.assets.forEach((asset, i) => {
      if (!asset.id) errors.push(`assets[${i}].id is required`);
      if (!asset.href) errors.push(`assets[${i}].href is required`);
      if (!Array.isArray(asset.roles) || asset.roles.length === 0) {
        errors.push(`assets[${i}].roles must be a non-empty array`);
      }
      if (!asset.copc || typeof asset.copc.resolution !== "number") {
        errors.push(`assets[${i}].copc.resolution is required and must be a number`);
      }
    });
  } else if (hasAssetsDir) {
    const ad = manifest.assets_dir;
    if (!ad.href) errors.push(`assets_dir.href is required`);
    if (!Array.isArray(ad.roles) || ad.roles.length === 0) {
      errors.push(`assets_dir.roles must be a non-empty array`);
    }
    if (!ad.copc || typeof ad.copc.resolution !== "number") {
      errors.push(`assets_dir.copc.resolution is required and must be a number`);
    }
    if (ad.pattern !== undefined && typeof ad.pattern !== "string") {
      errors.push(`assets_dir.pattern must be a string if given`);
    }
  }

  return errors;
}

function main() {
  const files = readdirSync(MANIFESTS_DIR).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  let failed = false;

  for (const file of files) {
    const raw = readFileSync(path.join(MANIFESTS_DIR, file), "utf-8");
    let manifest;
    try {
      manifest = loadYaml(raw);
    } catch (err) {
      console.error(`FAIL ${file}: invalid YAML -- ${err.message}`);
      failed = true;
      continue;
    }
    const errors = validateManifest(file, manifest);
    if (errors.length > 0) {
      failed = true;
      console.error(`FAIL ${file}:`);
      for (const e of errors) console.error(`  - ${e}`);
    } else {
      console.log(`ok   ${file}`);
    }
  }

  if (failed) {
    console.error("\nOne or more manifests failed validation.");
    process.exit(1);
  }
  console.log(`\nAll ${files.length} manifest(s) valid.`);
}

main();
