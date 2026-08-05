#!/usr/bin/env node
// Credential-free pre-merge checks that need no access to
// pointcloud.org's infrastructure at all -- run in the public repo's
// own `check-reachability` job (see
// .github/workflows/manifest-ingest.yml), not dispatched anywhere,
// since a plain HTTPS HEAD request needs nothing this repo doesn't
// already have. Complements scripts/validate-manifests.mjs (schema/
// local-file checks) and the infrastructure-side preflight checks
// (file existence, CRS consistency, pdal_filters validity -- those need
// real credentials, which this repo deliberately never holds, see
// manifests/README.md's security-boundary note).
//
// Checks, per changed dataset:
//   1. Every foreign (non-"s3://pointcloud/...") item asset href (from
//      items[]), the collection-level assets.thumbnail href if set, and
//      the stac_item/external_source href if either is used, that
//      resolves to a plain https:// URL is actually reachable (a HEAD
//      request, falling back to a Range-limited GET for servers that
//      reject HEAD). items_dir is never checked here -- it's always our
//      own bucket by schema.
//   2. The dataset's resolved JSON payload size, purely informational
//      (no hard limit enforced here, but a contributor opening a PR
//      still benefits from seeing it).
//
// Usage: node scripts/check-reachability.mjs <manifest.yaml> [...]
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { load as loadYaml } from "js-yaml";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: node scripts/check-reachability.mjs <manifest.yaml> [...]");
  process.exit(1);
}

const OWN_BUCKET_PREFIX = "s3://pointcloud/";
const AWS_DEFAULT_ENDPOINT = "https://s3.amazonaws.com";

/** Mirrors the ingest backend's own asset-href resolution for the one case this script needs: turning a foreign s3:// href (or a bare https:// one) into a checkable URL. Returns null for our own bucket or a VSI path -- nothing to check here. */
function resolveCheckableUrl(href, endpoint) {
  if (href.startsWith(OWN_BUCKET_PREFIX)) return null;
  if (href.startsWith("https://") || href.startsWith("http://")) return href;
  if (href.startsWith("s3://")) {
    const withoutScheme = href.slice("s3://".length);
    const slash = withoutScheme.indexOf("/");
    const bucket = slash === -1 ? withoutScheme : withoutScheme.slice(0, slash);
    const key = slash === -1 ? "" : withoutScheme.slice(slash + 1);
    const base = (endpoint ?? AWS_DEFAULT_ENDPOINT).replace(/\/*$/, "");
    return `${base}/${bucket}/${key}`;
  }
  return null; // VSI path or something else not generically checkable
}

async function checkReachable(url) {
  try {
    const head = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(10_000) });
    if (head.ok || head.status === 403) return { ok: true }; // 403 still proves the host/path resolves; many buckets reject unauthenticated HEAD but do serve the real GET
    // Some servers don't implement HEAD at all (405/501) -- fall back to
    // a byte-range GET so a real HEAD-unfriendly host isn't reported as
    // broken.
    if ([405, 501].includes(head.status)) {
      const get = await fetch(url, { method: "GET", headers: { Range: "bytes=0-0" }, signal: AbortSignal.timeout(10_000) });
      if (get.ok || get.status === 206 || get.status === 403) return { ok: true };
      return { ok: false, error: `GET fallback -> ${get.status}` };
    }
    return { ok: false, error: `HEAD -> ${head.status}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function resolveFilterStages(manifestDir, config) {
  if (!config?.pdal_filters_file) return config;
  const filtersPath = path.join(manifestDir, config.pdal_filters_file);
  const filters = JSON.parse(readFileSync(filtersPath, "utf-8"));
  const { pdal_filters_file, ...rest } = config;
  return { ...rest, pdal_filters: filters };
}

async function main() {
  let anyFailed = false;

  for (const file of files) {
    const raw = readFileSync(file, "utf-8");
    const manifest = loadYaml(raw);
    const manifestDir = path.dirname(file);
    const datasetId = manifest?.id ?? path.basename(manifestDir);
    const defaultEndpoint = manifest?.pointcloud_org?.default_endpoint;

    console.log(`[reachability] ${datasetId}:`);

    const urlsToCheck = [];
    for (const item of manifest?.items ?? []) {
      const data = item?.assets?.data;
      if (!data?.href) continue;
      const url = resolveCheckableUrl(data.href, data.endpoint ?? defaultEndpoint);
      if (url) urlsToCheck.push({ label: item.id ?? data.href, url });
    }
    if (manifest?.assets?.thumbnail?.href) {
      const url = resolveCheckableUrl(manifest.assets.thumbnail.href, defaultEndpoint);
      if (url) urlsToCheck.push({ label: "assets.thumbnail", url });
    }
    // stac_item/external_source both point at a URL to someone else's
    // JSON document, not our own bucket -- a bare https:// href, so
    // resolveCheckableUrl's plain-URL branch handles it directly.
    if (manifest?.stac_item?.href) {
      const url = resolveCheckableUrl(manifest.stac_item.href, defaultEndpoint);
      if (url) urlsToCheck.push({ label: "stac_item", url });
    }
    if (manifest?.external_source?.href) {
      const url = resolveCheckableUrl(manifest.external_source.href, defaultEndpoint);
      if (url) urlsToCheck.push({ label: "external_source", url });
    }

    if (urlsToCheck.length === 0) {
      console.log(`  no foreign/https URLs to check (everything is our own bucket, or nothing set)`);
    }
    for (const { label, url } of urlsToCheck) {
      const result = await checkReachable(url);
      if (result.ok) {
        console.log(`  ✅ ${label} -> ${url}`);
      } else {
        console.log(`  ❌ ${label} -> ${url}: ${result.error}`);
        anyFailed = true;
      }
    }

    // Informational payload-size estimate -- same resolution
    // build-datasets-payload.mjs does, just measured rather than
    // dispatched anywhere.
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
    const sizeBytes = Buffer.byteLength(JSON.stringify({ datasetId, manifest }));
    console.log(`  resolved payload size: ~${(sizeBytes / 1024).toFixed(1)} KB`);
  }

  if (anyFailed) {
    console.error("\nOne or more foreign/https URLs are not reachable.");
    process.exit(1);
  }
  console.log("\nAll foreign/https URLs reachable.");
}

main();
