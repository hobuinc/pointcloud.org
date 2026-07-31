#!/usr/bin/env node
// Parses one or more manifests/*.yaml files and prints a JSON payload
// of the shape { datasets: [{ datasetId, manifest }, ...] } to stdout --
// this is the client_payload body for the repository_dispatch this
// repo's .github/workflows/manifest-ingest.yml fires at
// hobuinc/pointcloud.org-infrastructure once a manifest PR merges.
//
// This repo intentionally never talks to the ingest Worker directly
// (no WORKER_INGEST_SHARED_SECRET lives here) -- see
// hobuinc/pointcloud.org-infrastructure's
// .github/workflows/receive-manifest-dispatch.yml, which receives this
// payload and forwards it to POST /trigger using that secret.
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

const datasets = files.map((file) => {
  const raw = readFileSync(file, "utf-8");
  const manifest = loadYaml(raw);
  const datasetId = manifest?.dataset?.id ?? path.basename(file, path.extname(file));
  return { datasetId, manifest };
});

process.stdout.write(JSON.stringify({ datasets }));
