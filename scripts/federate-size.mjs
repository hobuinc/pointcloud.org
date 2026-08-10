#!/usr/bin/env node
// Credential-free check: for a manifest requesting `pointcloud_org.federate:
// true`, how many bytes will actually get copied into pointcloud.org's own
// storage at ingest time? Needs nothing this repo doesn't already have (HEAD
// requests against URLs this PR's own manifest already names), so it runs
// directly in manifest-ingest.yml's `label-and-comment-federate` job --
// same trust-boundary reasoning as check-reachability.mjs/check-federate.mjs.
//
// Only checks the asset hrefs federation.ts actually copies -- items[]'s
// assets.data.href and (for a stac_item reference) the resolved item's own
// asset hrefs. ept_source is deliberately excluded: it's never federated
// (see federation.ts's fallback branch, referenced in check-federate.mjs's
// own doc comment), so a federate:true manifest that also sets ept_source
// would be a contradiction this script doesn't need to handle.
//
// Prints a single integer (total bytes, "0" if nothing measurable) to
// stdout -- meant to be captured straight into a step output:
//   BYTES=$(node scripts/federate-size.mjs <manifest.yaml> [...])
//
// Usage: node scripts/federate-size.mjs <manifest.yaml> [...]
import { readFileSync } from "node:fs";
import process from "node:process";
import { load as loadYaml } from "js-yaml";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.log("0");
  process.exit(0);
}

const OWN_BUCKET_PREFIX = "s3://pointcloud/";
const AWS_DEFAULT_ENDPOINT = "https://s3.amazonaws.com";

/** Same resolution as check-reachability.mjs's resolveCheckableUrl -- kept as its own copy here rather than a shared import, since neither script has a build step and this repo's scripts/ directory has no existing convention for sharing code between them. */
function resolveCheckableUrl(href, endpoint) {
  if (!href || href.startsWith(OWN_BUCKET_PREFIX)) return null;
  if (href.startsWith("https://") || href.startsWith("http://")) return href;
  if (href.startsWith("s3://")) {
    const withoutScheme = href.slice("s3://".length);
    const slash = withoutScheme.indexOf("/");
    const bucket = slash === -1 ? withoutScheme : withoutScheme.slice(0, slash);
    const key = slash === -1 ? "" : withoutScheme.slice(slash + 1);
    const base = (endpoint ?? AWS_DEFAULT_ENDPOINT).replace(/\/*$/, "");
    return `${base}/${bucket}/${key}`;
  }
  return null;
}

async function contentLength(url) {
  try {
    const head = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(15_000) });
    const len = head.headers.get("content-length");
    if (head.ok && len) return Number(len);
    return null;
  } catch {
    return null;
  }
}

async function main() {
  let totalBytes = 0;
  let anyUnknown = false;

  for (const file of files) {
    const manifest = loadYaml(readFileSync(file, "utf-8"));
    if (manifest?.pointcloud_org?.federate !== true) continue;

    const defaultEndpoint = manifest?.pointcloud_org?.default_endpoint;
    const urls = [];
    for (const item of manifest?.items ?? []) {
      const data = item?.assets?.data;
      const url = resolveCheckableUrl(data?.href, data?.endpoint ?? defaultEndpoint);
      if (url) urls.push(url);
    }
    // A `stac_item` reference is resolved server-side at ingest time (the
    // referenced document's own asset hrefs aren't known from this
    // manifest file alone) -- not measurable here without fetching and
    // parsing that foreign STAC Item too, which is more machinery than
    // this credential-free, best-effort estimate is worth. Falls through
    // to "unknown" for that case, same as any HEAD failure below.
    if (manifest?.stac_item && urls.length === 0) {
      anyUnknown = true;
      console.error(`[federate-size] ${manifest.id ?? file}: stac_item reference -- size not resolvable without fetching the foreign STAC Item, skipping`);
      continue;
    }

    for (const url of urls) {
      const bytes = await contentLength(url);
      if (bytes === null) {
        anyUnknown = true;
        console.error(`[federate-size] ${manifest.id ?? file}: could not determine size of ${url}`);
      } else {
        totalBytes += bytes;
      }
    }
  }

  if (anyUnknown && totalBytes === 0) {
    console.log("unknown");
  } else {
    console.log(String(totalBytes));
  }
}

main();
