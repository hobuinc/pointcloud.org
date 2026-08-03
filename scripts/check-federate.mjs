#!/usr/bin/env node
// Credential-free check: does any of the given manifest(s) request
// `dataset.federate: true`? Needs nothing this repo doesn't already
// have (just reading the YAML this PR already touched), so it runs
// directly in manifest-ingest.yml's own `check-federate` job, same
// trust-boundary reasoning as check-reachability.mjs.
//
// Prints exactly "true" or "false" to stdout (nothing else) -- meant to
// be captured straight into a step output:
//   FEDERATE=$(node scripts/check-federate.mjs <manifest.yaml> [...])
//
// Usage: node scripts/check-federate.mjs <manifest.yaml> [...]
import { readFileSync } from "node:fs";
import process from "node:process";
import { load as loadYaml } from "js-yaml";

const files = process.argv.slice(2);
if (files.length === 0) {
  // No changed manifest files (e.g. a schema.json-only PR) -- nothing
  // to check, and nothing to report.
  console.log("false");
  process.exit(0);
}

let anyFederate = false;
for (const file of files) {
  const manifest = loadYaml(readFileSync(file, "utf-8"));
  if (manifest?.dataset?.federate === true) {
    anyFederate = true;
    console.error(`[check-federate] ${manifest.dataset.id ?? file}: dataset.federate is true`);
  }
}

console.log(anyFederate ? "true" : "false");
