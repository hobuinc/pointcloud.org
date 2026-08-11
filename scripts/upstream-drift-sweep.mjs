#!/usr/bin/env node
// Archive-wide upstream-drift sweep: check every dataset's external URLs
// and emit a Markdown report on stdout for the tracking issue.
//
// Run by .github/workflows/upstream-drift-sweep.yml (weekly + on demand).
// See that workflow's header for why this exists at all -- most of this
// archive is references to third-party data that moves without notice.
//
// Credential-free by construction: plain HEAD requests against URLs the
// manifests already publish. Same reason check-reachability.mjs runs in
// this repo rather than behind the infrastructure trust boundary.
//
// Exit code is the signal the workflow branches on:
//   0 = every checked URL resolved
//   1 = at least one dataset has a problem
//
// Deliberately NOT reusing check-reachability.mjs as a library: that
// script is a pre-merge gate whose job is to fail loudly on the one
// dataset in a PR. This one has to keep going after a failure, attribute
// each failure to a dataset and an owner, and summarize. Same HEAD-request
// idea, different control flow and output contract -- so they share the
// approach rather than the code, and each stays readable.
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { load as loadYaml } from "js-yaml";

const MANIFEST_ROOT = "manifests";

/** How many URLs to check at once. Enough to finish the archive quickly, low enough not to look like abuse to USGS. */
const CONCURRENCY = 8;

/** Per-request timeout. USGS endpoints are occasionally slow rather than dead, and a false "broken" report is worse than a slow sweep. */
const TIMEOUT_MS = 20_000;

/**
 * Where the human-facing dataset pages live. Every dataset resolves at
 * `<SITE>/datasets/<id>/` -- flat, using the leaf id even for datasets
 * nested under a grouping directory (confirmed live: usgs-3dep's
 * MN_SEDriftless_3_2021 serves at /datasets/MN_SEDriftless_3_2021/).
 * That flatness is guaranteed by validate-manifests.mjs's global
 * id-uniqueness check.
 */
const SITE_BASE_URL = process.env.SITE_BASE_URL ?? "https://pointcloud.org";

/** `owner/repo`, for building manifest permalinks. */
const REPO_SLUG = process.env.GITHUB_REPOSITORY ?? "hobuinc/pointcloud.org";

/**
 * Branch the manifest links should point at. Uses the ref the sweep is
 * running on so a report generated from a branch links to that branch's
 * manifests rather than silently to main -- GITHUB_REF_NAME is set by
 * Actions for both workflow_dispatch and schedule.
 */
const REF_NAME = process.env.GITHUB_REF_NAME ?? "main";

/**
 * Cap on table rows. At the scale this is built for (1000s of datasets) a
 * bad upstream day could break hundreds at once, and a GitHub issue body
 * is limited to 65536 characters -- a report that exceeds it fails to
 * post at all, which is strictly worse than a truncated one. The
 * remainder is still counted in the summary line.
 */
const MAX_ROWS = 200;

async function findManifests(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await findManifests(full)));
    else if (entry.name === "manifest.yaml") out.push(full);
  }
  return out;
}

/**
 * Every externally-hosted URL a dataset depends on, with a label for
 * reporting. Mirrors what the ingest pipeline actually fetches:
 * `ept_source` for EPT datasets, `items[].assets.*.href` for
 * explicitly-listed assets, and a `stac_item` reference's own document.
 *
 * URLs already inside pointcloud.org's own bucket are skipped: they
 * aren't "upstream", and a broken one is our bug, not drift.
 */
function externalUrls(manifest) {
  const urls = [];
  const push = (label, href) => {
    if (typeof href !== "string") return;
    if (!/^https?:\/\//i.test(href)) return; // s3:// / VSI paths aren't HEAD-checkable without credentials
    if (href.includes("data.pointcloud.org")) return; // our own storage
    urls.push({ label, href });
  };

  // These three are each an object with an `href`, at the TOP level of
  // the manifest -- not nested under pointcloud_org, and not bare
  // strings. Matched to check-reachability.mjs's own traversal, which is
  // the authoritative reading of the schema; getting this wrong silently
  // under-reports (an early version of this script found 24 URLs across
  // 68 datasets instead of 71, because every EPT source was missed).
  push("ept_source", manifest?.ept_source?.href);
  push("stac_item", manifest?.stac_item?.href);
  push("external_source", manifest?.external_source?.href);
  for (const item of manifest?.items ?? []) {
    for (const [key, asset] of Object.entries(item?.assets ?? {})) {
      push(`items[${item?.id ?? "?"}].assets.${key}`, asset?.href);
    }
  }
  // Metadata documents are worth checking too -- a dead license or
  // provenance link is a real (if less severe) form of drift, and these
  // are cheap.
  for (const link of manifest?.links ?? []) {
    if (link?.rel === "license" || link?.rel === "about") push(`links.${link.rel}`, link?.href);
  }
  return urls;
}

async function head(href) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let res = await fetch(href, { method: "HEAD", redirect: "follow", signal: controller.signal });
    // Some hosts (notably a few USGS/S3 paths) reject HEAD but serve GET
    // fine. A 403/405 on HEAD alone is not evidence the data is gone, so
    // confirm with a ranged GET before calling it broken.
    if (res.status === 403 || res.status === 405 || res.status === 501) {
      res = await fetch(href, {
        method: "GET",
        redirect: "follow",
        headers: { Range: "bytes=0-0" },
        signal: controller.signal,
      });
    }
    return { ok: res.ok || res.status === 206, status: res.status };
  } catch (err) {
    return { ok: false, status: 0, error: err.name === "AbortError" ? `timeout after ${TIMEOUT_MS}ms` : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

async function mapLimit(items, limit, fn) {
  const results = [];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await fn(items[index]);
      }
    }),
  );
  return results;
}

const manifestFiles = (await findManifests(MANIFEST_ROOT)).sort();
const datasets = [];

for (const file of manifestFiles) {
  let manifest;
  try {
    manifest = loadYaml(readFileSync(file, "utf-8"));
  } catch (err) {
    datasets.push({ id: file, file, owner: null, checks: [], parseError: String(err) });
    continue;
  }
  const owner = (manifest?.providers ?? [])
    .map((p) => p?.pointcloud_org?.contact?.github_owner)
    .find((o) => typeof o === "string" && o.length > 0);
  datasets.push({
    id: manifest?.id ?? path.basename(path.dirname(file)),
    file,
    owner: owner ?? null,
    urls: externalUrls(manifest),
    checks: [],
  });
}

// Flatten so concurrency is global rather than per-dataset -- a dataset
// with 1,000 listed tiles shouldn't serialize behind one with 1.
const allChecks = datasets.flatMap((d) => (d.urls ?? []).map((u) => ({ dataset: d, ...u })));
const results = await mapLimit(allChecks, CONCURRENCY, async (c) => ({ ...c, result: await head(c.href) }));
for (const r of results) r.dataset.checks.push(r);

const broken = datasets.filter((d) => d.parseError || d.checks.some((c) => !c.result.ok));
const checkedUrlCount = results.length;

// ---- report ----
const lines = [];
const stamp = new Date().toISOString().replace(/\.\d+Z$/, "Z");

if (broken.length === 0) {
  lines.push(`✅ **Upstream sweep clean** as of ${stamp}.`);
  lines.push("");
  lines.push(`Checked ${checkedUrlCount} external URL(s) across ${datasets.length} dataset(s). Everything resolved.`);
  process.stdout.write(lines.join("\n") + "\n");
  process.exit(0);
}

lines.push(`⚠️ **${broken.length} of ${datasets.length} dataset(s) have upstream problems** as of ${stamp}.`);
lines.push("");
lines.push(
  `This issue is maintained automatically by the [weekly upstream-drift sweep](https://github.com/${REPO_SLUG}/blob/${REF_NAME}/.github/workflows/upstream-drift-sweep.yml) ` +
    `and rewritten in place on every run. It closes itself when a sweep comes back clean.`,
);
lines.push("");
lines.push(`Checked ${checkedUrlCount} external URL(s) across ${datasets.length} dataset(s).`);
lines.push("");

// Owners get one @-mention at the top rather than one per URL, so a
// dataset with many broken tiles doesn't spam a single person.
const owners = [...new Set(broken.map((d) => d.owner).filter(Boolean))];
if (owners.length > 0) {
  lines.push(`Maintainers of affected datasets: ${owners.map((o) => `@${o}`).join(", ")}`);
  lines.push("");
}

lines.push("---");
lines.push("");

// A table, not a section per dataset. This report is built for an archive
// of 1000s of datasets, where a section-per-failure report is unreadable
// and unscannable -- one row per broken dataset, and *only* broken ones,
// keeps "what needs attention right now" answerable at a glance.
lines.push("| Dataset | Reachability | Manifest | Maintainer | Failing |");
lines.push("| --- | :---: | --- | --- | --- |");

const rows = broken.slice(0, MAX_ROWS);
for (const d of rows) {
  const datasetLink = `[\`${d.id}\`](${SITE_BASE_URL}/datasets/${encodeURIComponent(d.id)}/)`;
  const manifestLink = `[\`${d.file}\`](https://github.com/${REPO_SLUG}/blob/${REF_NAME}/${d.file})`;
  const maintainer = d.owner ? `@${d.owner}` : "_none_";

  let detail;
  if (d.parseError) {
    detail = `manifest failed to parse`;
  } else {
    const failures = d.checks.filter((c) => !c.result.ok);
    // Summarize rather than list: a dataset with 1,000 listed tiles can
    // have 1,000 failing URLs, and that belongs nowhere near a table
    // cell. One representative reason plus a count is what a maintainer
    // needs to decide whether to look.
    const first = failures[0];
    const why = first.result.error ? first.result.error : `HTTP ${first.result.status}`;
    const more = failures.length > 1 ? ` (+${failures.length - 1} more)` : "";
    detail = `\`${first.label}\` → ${why}${more}`;
  }
  lines.push(`| ${datasetLink} | ❌ | ${manifestLink} | ${maintainer} | ${detail} |`);
}

if (broken.length > rows.length) {
  lines.push("");
  lines.push(
    `_…and ${broken.length - rows.length} more broken dataset(s), omitted to stay under GitHub's ` +
      `issue-body size limit. Re-run the sweep after fixing these to see the rest._`,
  );
}

lines.push("");
lines.push("---");
lines.push("");
lines.push("**What to do about it**");
lines.push("");
lines.push(
  "- If the data moved, update the manifest's URL in a pull request. Merging it re-ingests the dataset automatically.",
);
lines.push(
  "- If the data is gone for good, delete the dataset directory. Merging that de-indexes it; the archived copy in " +
    "pointcloud.org's own storage is kept either way.",
);
lines.push(
  "- If it was a transient outage, re-run the sweep from the Actions tab (or comment " +
    "`@pointcloud-org, please check-reachability`) and this issue will close itself.",
);

process.stdout.write(lines.join("\n") + "\n");
process.exit(1);
