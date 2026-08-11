#!/usr/bin/env node
// Credential-free check: if a manifest requests `pointcloud_org.federate:
// true`, refuse to copy anything whose filename isn't a recognized
// point-cloud or raster format.
//
// Why this exists: `federate: true` tells the ingest pipeline to copy the
// referenced bytes into pointcloud.org's own storage (see the
// `federated` label's PR comment, and federation.ts on the
// infrastructure side). That is the one manifest field that makes this
// project pull arbitrary, submitter-specified URLs into its own bucket
// and serve them under its own domain. Without a format allowlist, a
// manifest could point `assets.data.href` at anything at all -- an
// archive, an installer, a video -- and the pipeline would dutifully
// copy and republish it. This is the guard for that.
//
// The allowlist is deliberately narrow and extension-based:
//
//   .copc.laz  Cloud Optimized Point Cloud (the archive's native form)
//   .laz       compressed LAS
//   .las       uncompressed LAS
//   .tif/.tiff GeoTIFF / COG (derivative rasters, e.g. a supplied DTM)
//
// Extension-matching rather than content-sniffing is on purpose: this
// check must stay credential-free and cheap enough to run on every PR
// (same trust-boundary reasoning as check-reachability.mjs and
// check-federate.mjs -- see manifests/README.md's "How ingest actually
// happens"), and it runs BEFORE anything is fetched. It is a policy
// gate, not a format validator; the real format check happens later,
// when PDAL actually opens the file during metadata extraction.
//
// Only `federate: true` manifests are checked. A manifest that merely
// *references* foreign data without federating it is not copying
// anything, so what that URL points at is the publisher's business, not
// ours.
//
// `ept_source` is deliberately not checked: it's never federated (it's a
// directory-style endpoint, not a single file -- see federate-size.mjs's
// same exclusion), so it can't be copied by this path.
//
// Exits non-zero and prints every offending href when something isn't
// allowed, so the PR check fails with an actionable message.
//
// Usage: node scripts/check-federate-extensions.mjs <manifest.yaml> [...]
import { readFileSync } from "node:fs";
import process from "node:process";
import { load as loadYaml } from "js-yaml";

/**
 * Allowed filename endings, lowercased. `.copc.laz` is listed
 * separately from `.laz` for documentation value only -- it's already
 * covered by the `.laz` suffix match.
 */
const ALLOWED_EXTENSIONS = [".copc.laz", ".laz", ".las", ".tif", ".tiff"];

/**
 * Strips query string and fragment before looking at the extension, so
 * a presigned or parameterized URL
 * ("https://host/tile.laz?X-Amz-Signature=...") is judged on its actual
 * path rather than failing on the query.
 */
function pathnameOf(href) {
  const withoutFragment = href.split("#")[0];
  const withoutQuery = withoutFragment.split("?")[0];
  // Not using `new URL()`: hrefs here may be s3:// or a bare VSI-style
  // path, and this only needs the trailing filename either way.
  return withoutQuery;
}

function isAllowed(href) {
  const lower = pathnameOf(href).toLowerCase();
  return ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.log("[check-federate-extensions] no manifest files given -- nothing to check");
  process.exit(0);
}

const violations = [];
let federatingDatasets = 0;

for (const file of files) {
  const manifest = loadYaml(readFileSync(file, "utf-8"));
  if (manifest?.pointcloud_org?.federate !== true) continue;
  federatingDatasets += 1;
  const datasetId = manifest.id ?? file;

  // Every href federation.ts would actually copy. Mirrors
  // federate-size.mjs's own traversal so the two agree on what "the
  // data being copied" means.
  const hrefs = [];
  for (const item of manifest?.items ?? []) {
    for (const [assetKey, asset] of Object.entries(item?.assets ?? {})) {
      if (typeof asset?.href === "string") hrefs.push({ assetKey, itemId: item?.id, href: asset.href });
    }
  }

  if (manifest?.stac_item && hrefs.length === 0) {
    // A `stac_item` reference's real asset hrefs live in a foreign STAC
    // document this check deliberately doesn't fetch. Flagged rather
    // than silently passed: combining `federate: true` with `stac_item`
    // means asking to copy files whose names nothing has checked.
    violations.push(
      `${datasetId}: uses "stac_item" together with "federate: true", so the filenames to be copied ` +
        `are not knowable from this manifest. Either list the assets explicitly under "items", or drop ` +
        `"federate: true" and reference the data in place.`,
    );
    continue;
  }

  for (const { assetKey, itemId, href } of hrefs) {
    if (!isAllowed(href)) {
      violations.push(
        `${datasetId}: item "${itemId ?? "(unnamed)"}" asset "${assetKey}" href is not an allowed ` +
          `format for federation: ${href}`,
      );
    }
  }
}

if (federatingDatasets === 0) {
  console.log("[check-federate-extensions] no dataset requests federate: true -- nothing to check");
  process.exit(0);
}

if (violations.length > 0) {
  console.error(
    `\n[check-federate-extensions] refusing to federate ${violations.length} asset(s)/dataset(s).\n` +
      `\n"federate: true" copies the referenced bytes into pointcloud.org's own storage and republishes\n` +
      `them under its domain, so only recognized point-cloud and raster formats are permitted:\n` +
      `  ${ALLOWED_EXTENSIONS.join("  ")}\n`,
  );
  for (const v of violations) console.error(`  - ${v}`);
  console.error("");
  process.exit(1);
}

console.log(
  `[check-federate-extensions] ok -- every asset in ${federatingDatasets} federating dataset(s) ` +
    `is an allowed format (${ALLOWED_EXTENSIONS.join(", ")})`,
);
