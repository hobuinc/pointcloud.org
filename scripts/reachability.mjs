#!/usr/bin/env node
// Archive-wide reachability sweep, built to fan out across many runners.
//
// Three modes, so GitHub Actions can parallelize the work:
//
//   plan   --shards N            emit the matrix + work statistics as JSON
//   check  --shard I --shards N  check this shard's slice, write JSON results
//   report --results <dir>       aggregate every shard's JSON into Markdown
//
// Used by .github/workflows/upstream-drift-sweep.yml (weekly + on demand)
// and by the `@pointcloud-org, please check-reachability` command.
//
// ## Why sharded
//
// The single-process version was O(every URL in the archive) in one job.
// At the scale this is built for -- 1000s of datasets, and individual
// datasets with 10,000s of listed tiles (wi-adams-2019 alone lists 1,026)
// -- that is minutes to hours of wall clock in one runner, with a single
// network hiccup taking the whole sweep with it. Sharding turns wall
// clock into a division problem and isolates failures to one shard.
//
// Work is sharded by URL, not by dataset, deliberately: dataset sizes
// differ by three orders of magnitude here, so per-dataset sharding just
// moves the bottleneck to whichever runner draws the biggest dataset.
// Round-robin over the flattened URL list keeps every runner's slice
// within one URL of every other's.
//
// ## Why sampled
//
// Even sharded, checking every tile of every dataset every week is both
// wasteful and rude to the hosts involved (USGS in particular). The
// question this sweep answers is "has this dataset drifted upstream" --
// moved, been renamed, been withdrawn -- and that is answerable from a
// sample: if a prefix is gone, any tile under it is gone.
//
// So each dataset contributes at most SAMPLE_PER_DATASET URLs, and the
// ones that matter most are always included first (ept_source /
// stac_item / external_source are the single points of failure for a
// whole dataset; individual tiles are not). The report discloses when it
// sampled rather than checking exhaustively -- silently checking a
// subset while implying completeness would be worse than either.
//
// Credential-free by construction: plain HEAD requests against URLs the
// manifests already publish.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { load as loadYaml } from "js-yaml";

const MANIFEST_ROOT = "manifests";

/** Concurrent requests per runner. Multiplied by the shard count for total archive-wide concurrency, so keep it modest. */
const CONCURRENCY = 8;

/** Per-request timeout. Some USGS endpoints are slow rather than dead, and a false "broken" is worse than a slow sweep. */
const TIMEOUT_MS = 20_000;

/**
 * Max URLs checked per dataset. See the "Why sampled" note above. Set
 * `SAMPLE_PER_DATASET=0` to check exhaustively (useful for a one-off
 * audit; not what the weekly sweep should do).
 */
const SAMPLE_PER_DATASET = Number(process.env.SAMPLE_PER_DATASET ?? 25);

/** Target URLs per shard, used to size the matrix. GitHub caps a matrix at 256 jobs. */
const URLS_PER_SHARD = Number(process.env.URLS_PER_SHARD ?? 400);
const MAX_SHARDS = 64;

const SITE_BASE_URL = process.env.SITE_BASE_URL ?? "https://pointcloud.org";
const REPO_SLUG = process.env.GITHUB_REPOSITORY ?? "hobuinc/pointcloud.org";
const REF_NAME = process.env.GITHUB_REF_NAME ?? "main";

/** Cap on broken-dataset rows. A GitHub issue body is limited to 65536 chars, and an oversized body fails to post entirely. */
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
 * Splits a dataset's URLs into `critical` (a failure means the whole
 * dataset is broken) and `tiles` (a failure means one file is broken).
 *
 * The distinction drives sampling: criticals are always checked, tiles
 * are sampled. It also drives the hosted/remote classification below.
 */
function classifyUrls(manifest) {
  const critical = [];
  const tiles = [];
  const push = (into, label, href) => {
    if (typeof href !== "string") return;
    if (!/^https?:\/\//i.test(href)) return; // s3:// and VSI paths aren't HEAD-checkable without credentials
    if (href.includes("data.pointcloud.org")) return; // our own storage isn't "upstream"
    into.push({ label, href });
  };

  // Each of these is an object with an `href`, at the TOP level of the
  // manifest. Matched to check-reachability.mjs's traversal, which is the
  // authoritative reading of the schema.
  push(critical, "ept_source", manifest?.ept_source?.href);
  push(critical, "stac_item", manifest?.stac_item?.href);
  push(critical, "external_source", manifest?.external_source?.href);
  for (const link of manifest?.links ?? []) {
    if (link?.rel === "license" || link?.rel === "about") push(critical, `links.${link.rel}`, link?.href);
  }
  for (const item of manifest?.items ?? []) {
    for (const [key, asset] of Object.entries(item?.assets ?? {})) {
      push(tiles, `items[${item?.id ?? "?"}].assets.${key}`, asset?.href);
    }
  }
  return { critical, tiles };
}

/** Reads every manifest once and returns the full picture: classification, owner, and the sampled work list. */
async function loadDatasets() {
  const files = (await findManifests(MANIFEST_ROOT)).sort();
  const datasets = [];
  for (const file of files) {
    let manifest;
    try {
      manifest = loadYaml(readFileSync(file, "utf-8"));
    } catch (err) {
      datasets.push({ id: file, file, owner: null, parseError: String(err), urls: [], totalUrls: 0, category: "unknown" });
      continue;
    }
    const { critical, tiles } = classifyUrls(manifest);
    const owner = (manifest?.providers ?? [])
      .map((p) => p?.pointcloud_org?.contact?.github_owner)
      .find((o) => typeof o === "string" && o.length > 0);

    const totalUrls = critical.length + tiles.length;
    // Criticals always; tiles up to the remaining budget. Evenly spaced
    // through the tile list rather than the first N, so a sample of a
    // 10,000-tile dataset spans the whole listing instead of just its
    // first page -- a prefix that changed partway through is exactly the
    // kind of drift worth catching.
    let sampled = [...critical];
    if (SAMPLE_PER_DATASET === 0) {
      sampled = [...critical, ...tiles];
    } else {
      const budget = Math.max(0, SAMPLE_PER_DATASET - critical.length);
      if (tiles.length <= budget) {
        sampled.push(...tiles);
      } else if (budget > 0) {
        const step = tiles.length / budget;
        for (let i = 0; i < budget; i += 1) sampled.push(tiles[Math.floor(i * step)]);
      }
    }

    datasets.push({
      id: manifest?.id ?? path.basename(path.dirname(file)),
      file,
      owner: owner ?? null,
      // "remote" = depends on at least one third-party URL. "hosted" =
      // everything it needs already lives in pointcloud.org's own
      // storage (either natively or because it was federated), so there
      // is nothing upstream that can drift.
      category: totalUrls > 0 ? "remote" : "hosted",
      totalUrls,
      sampledUrls: sampled.length,
      urls: sampled,
    });
  }
  return datasets;
}

/** Flattened, deterministically ordered work list. Every mode derives its slice from this same order. */
function workList(datasets) {
  const work = [];
  for (const d of datasets) for (const u of d.urls) work.push({ datasetId: d.id, ...u });
  return work;
}

async function head(href) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let res = await fetch(href, { method: "HEAD", redirect: "follow", signal: controller.signal });
    // Some hosts reject HEAD but serve GET fine, so a 403/405 on HEAD
    // alone is not evidence the data is gone.
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
    Array.from({ length: Math.min(limit, items.length) || 1 }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await fn(items[index]);
      }
    }),
  );
  return results;
}

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i === process.argv.length - 1) return fallback;
  return process.argv[i + 1];
}

const mode = process.argv[2];

// ---------------------------------------------------------------- plan
if (mode === "plan") {
  const datasets = await loadDatasets();
  const work = workList(datasets);
  const shards = Math.min(MAX_SHARDS, Math.max(1, Math.ceil(work.length / URLS_PER_SHARD)));
  const plan = {
    shards,
    // The matrix value GitHub Actions consumes.
    shardIds: Array.from({ length: shards }, (_, i) => i),
    datasetCount: datasets.length,
    hosted: datasets.filter((d) => d.category === "hosted").length,
    remote: datasets.filter((d) => d.category === "remote").length,
    urlsToCheck: work.length,
    urlsTotal: datasets.reduce((n, d) => n + d.totalUrls, 0),
    sampled: SAMPLE_PER_DATASET > 0,
    samplePerDataset: SAMPLE_PER_DATASET,
  };
  process.stdout.write(JSON.stringify(plan) + "\n");
  process.exit(0);
}

// --------------------------------------------------------------- check
if (mode === "check") {
  const shard = Number(arg("shard", "0"));
  const shards = Number(arg("shards", "1"));
  const out = arg("out", `reachability-shard-${shard}.json`);

  const datasets = await loadDatasets();
  const work = workList(datasets);
  // Round-robin, not contiguous chunks: adjacent entries in the work list
  // belong to the same dataset and therefore usually the same host, so
  // contiguous slicing would point one runner at one host as fast as it
  // can go. Round-robin spreads each runner's requests across hosts.
  const mine = work.filter((_, i) => i % shards === shard);

  const checked = await mapLimit(mine, CONCURRENCY, async (w) => ({
    datasetId: w.datasetId,
    label: w.label,
    href: w.href,
    result: await head(w.href),
  }));

  // Only failures are carried forward. A clean check is fully described
  // by its count, and shipping every success between jobs is how the
  // original 11 KB comment happened.
  const failures = checked.filter((c) => !c.result.ok);
  writeFileSync(
    out,
    JSON.stringify({
      shard,
      shards,
      checked: checked.length,
      failures,
      // Dataset-level metadata travels with shard 0 only, so the report
      // job doesn't have to re-read every manifest and the payload
      // doesn't repeat identical data N times.
      datasets:
        shard === 0
          ? datasets.map((d) => ({
              id: d.id,
              file: d.file,
              owner: d.owner,
              category: d.category,
              totalUrls: d.totalUrls,
              sampledUrls: d.sampledUrls,
              parseError: d.parseError ?? null,
            }))
          : [],
    }) + "\n",
  );
  console.log(`shard ${shard}/${shards}: checked ${checked.length} URL(s), ${failures.length} failing -> ${out}`);
  process.exit(0);
}

// -------------------------------------------------------------- report
if (mode === "report") {
  const dir = arg("results", ".");
  const shardFiles = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.startsWith("reachability-shard-") && e.name.endsWith(".json")) shardFiles.push(full);
    }
  };
  walk(dir);

  let checked = 0;
  const failures = [];
  let datasetMeta = [];
  for (const f of shardFiles) {
    const shardResult = JSON.parse(readFileSync(f, "utf-8"));
    checked += shardResult.checked ?? 0;
    failures.push(...(shardResult.failures ?? []));
    if ((shardResult.datasets ?? []).length > 0) datasetMeta = shardResult.datasets;
  }

  const byId = new Map(datasetMeta.map((d) => [d.id, d]));
  const failuresByDataset = new Map();
  for (const f of failures) {
    if (!failuresByDataset.has(f.datasetId)) failuresByDataset.set(f.datasetId, []);
    failuresByDataset.get(f.datasetId).push(f);
  }
  const parseErrors = datasetMeta.filter((d) => d.parseError);

  const hosted = datasetMeta.filter((d) => d.category === "hosted").length;
  const remote = datasetMeta.filter((d) => d.category === "remote").length;
  const totalUrls = datasetMeta.reduce((n, d) => n + (d.totalUrls ?? 0), 0);
  const brokenIds = [...new Set([...failuresByDataset.keys(), ...parseErrors.map((d) => d.id)])];
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const sampled = totalUrls > checked;

  const lines = [];
  lines.push(
    brokenIds.length === 0
      ? `✅ **Reachability verified** — every checked URL resolved, as of ${stamp}.`
      : `⚠️ **Reachability: ${brokenIds.length} dataset(s) unreachable**, as of ${stamp}.`,
  );
  lines.push("");
  lines.push("| Category | Datasets | URLs checked |");
  lines.push("| --- | ---: | ---: |");
  lines.push(`| Hosted (in pointcloud.org storage) | ${hosted} | — |`);
  lines.push(`| Remote (third-party) | ${remote} | ${checked} |`);
  lines.push(`| **Total** | **${hosted + remote}** | **${checked}** |`);
  lines.push("");
  if (sampled) {
    lines.push(
      `_Sampled ${checked} of ${totalUrls} remote URL(s): every dataset's ept_source/stac_item/external_source is ` +
        `always checked, plus up to ${SAMPLE_PER_DATASET} of its listed assets spread evenly through the listing. ` +
        `Checked across ${shardFiles.length} parallel shard(s)._`,
    );
    lines.push("");
  }

  if (brokenIds.length === 0) {
    process.stdout.write(lines.join("\n") + "\n");
    process.exit(0);
  }

  const owners = [...new Set(brokenIds.map((id) => byId.get(id)?.owner).filter(Boolean))];
  if (owners.length > 0) {
    lines.push(`Maintainers of affected datasets: ${owners.map((o) => `@${o}`).join(", ")}`);
    lines.push("");
  }

  lines.push("| Dataset | Reachability | Manifest | Maintainer | Failing |");
  lines.push("| --- | :---: | --- | --- | --- |");
  for (const id of brokenIds.slice(0, MAX_ROWS)) {
    const meta = byId.get(id) ?? { id, file: "(unknown)", owner: null };
    const datasetLink = `[\`${id}\`](${SITE_BASE_URL}/datasets/${encodeURIComponent(id)}/)`;
    const manifestLink = `[\`${meta.file}\`](https://github.com/${REPO_SLUG}/blob/${REF_NAME}/${meta.file})`;
    const maintainer = meta.owner ? `@${meta.owner}` : "_none_";
    let detail;
    if (meta.parseError) {
      detail = "manifest failed to parse";
    } else {
      const fs = failuresByDataset.get(id) ?? [];
      const first = fs[0];
      const why = first?.result?.error ? first.result.error : `HTTP ${first?.result?.status}`;
      const more = fs.length > 1 ? ` (+${fs.length - 1} more)` : "";
      detail = `\`${first?.label}\` → ${why}${more}`;
    }
    lines.push(`| ${datasetLink} | ❌ | ${manifestLink} | ${maintainer} | ${detail} |`);
  }
  if (brokenIds.length > MAX_ROWS) {
    lines.push("");
    lines.push(`_…and ${brokenIds.length - MAX_ROWS} more, omitted to stay under GitHub's issue-body size limit._`);
  }
  lines.push("");
  lines.push("**What to do about it**");
  lines.push("");
  lines.push("- If the data moved, update the manifest's URL in a pull request. Merging it re-ingests the dataset.");
  lines.push(
    "- If it's gone for good, delete the dataset directory. Merging de-indexes it; any archived copy in " +
      "pointcloud.org's own storage is kept regardless.",
  );
  lines.push("- If it was a transient outage, re-run the sweep and this report will clear itself.");

  process.stdout.write(lines.join("\n") + "\n");
  process.exit(1);
}

console.error(`usage: reachability.mjs plan --shards N | check --shard I --shards N [--out FILE] | report --results DIR`);
process.exit(2);
