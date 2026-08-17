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

/** Extra attempts for a URL that failed in a way that might be transient. See head(). */
const RETRIES = Number(process.env.REACHABILITY_RETRIES ?? 2);
const RETRY_BACKOFF_MS = Number(process.env.REACHABILITY_RETRY_BACKOFF_MS ?? 1500);

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

/** Where published STAC lives. `pointcloud_org:ingest` on a Collection records the PR that last ingested it. */
const DATA_BASE_URL = process.env.DATA_PUBLIC_BASE_URL ?? "https://data.pointcloud.org";

/**
 * Cap on how many datasets get a PR comment in one sweep.
 *
 * A single upstream bucket reorganizing can break hundreds of datasets at
 * once. The tracking issue is the exhaustive record; per-PR comments are a
 * courtesy ping to the person who contributed each one, and several hundred
 * of those in one minute is indistinguishable from spam (and would burn the
 * token's secondary rate limit).
 */
const MAX_PR_COMMENTS = Number(process.env.MAX_PR_COMMENTS ?? 25);

/**
 * The three kinds of URL a manifest names, and why the difference decides
 * whether a human gets woken up.
 *
 *  - SOURCE: `ept_source`/`stac_item`/`external_source`. One of these failing
 *    means the dataset cannot be resolved at all.
 *  - DOC: the `license` and `about` links. Provenance for humans. Worth
 *    reporting -- a dead license link is real drift in the manifest -- but the
 *    data is untouched, so it must not mark the dataset unreachable, fail the
 *    sweep, or comment on anyone's pull request.
 *  - asset: everything else, i.e. the actual data.
 *
 * Conflating the last two is what made the 2026-08-17 sweeps cry wolf: `autzen`
 * is hosted in our own storage and perfectly readable, and was reported
 * unreachable because github.com answered 503 to a runner asking about its
 * license page. It also produced the nonsense "2 of 1 checked asset(s)",
 * because link failures were counted against a denominator that excluded them.
 */
const SOURCE_LABELS = new Set(["ept_source", "stac_item", "external_source"]);
const isDocLabel = (label) => label === "links.license" || label === "links.about";

const GH_API = "https://api.github.com";
const GH_TOKEN = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? "";

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
      // Assets only, excluding criticals. The report needs this to say
      // "all N checked assets failed" accurately -- comparing asset
      // failures against sampledUrls (which includes the license/about/
      // ept_source criticals) undercounts and reports "23 of 25" when
      // every asset it checked was in fact broken.
      // Assets only: excludes both the criticals and the license/about links,
      // so "N of M checked asset(s)" compares like with like. Counting links
      // in the denominator (or, worse, in the numerator only) is how a report
      // came to read "2 of 1".
      sampledAssets: sampled.filter((u) => !SOURCE_LABELS.has(u.label) && !isDocLabel(u.label)).length,
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

/** GitHub API GET returning parsed JSON, or null on any failure. Best-effort by design: see resolvePullRequests(). */
async function gh(pathname, { method = "GET", body = undefined } = {}) {
  if (!GH_TOKEN) return null;
  try {
    const res = await fetch(`${GH_API}${pathname}`, {
      method,
      headers: {
        authorization: `Bearer ${GH_TOKEN}`,
        accept: "application/vnd.github+json",
        "user-agent": "pointcloud-org-drift-sweep",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      console.error(`[gh] ${method} ${pathname} -> HTTP ${res.status}`);
      return null;
    }
    return res.status === 204 ? {} : await res.json();
  } catch (err) {
    console.error(`[gh] ${method} ${pathname} threw: ${err}`);
    return null;
  }
}

/**
 * The pull request to report each broken dataset back to.
 *
 * A drift report is only useful if it reaches whoever contributed the
 * dataset, and the place they are already subscribed to is the PR that added
 * it -- or, better, whichever PR touching it is currently active. Three
 * sources, most authoritative first:
 *
 *  1. `pointcloud_org:ingest.pull_request_number` on the dataset's published
 *     STAC Collection. Written by the ingest pipeline, which is the only code
 *     that knows for certain which PR produced the current state.
 *  2. The PR(s) associated with the latest commit touching the dataset's
 *     manifest directory. Covers everything ingested before (1) existed.
 *  3. Any *open* PR that touches that directory. Fetched once for the whole
 *     sweep rather than per dataset.
 *
 * Whichever candidate was updated most recently wins, so an open fix-in-
 * progress beats the original ingest PR -- that is what "last active" means
 * here, and it is where a comment does the most good.
 *
 * Entirely best-effort: every failure path yields "no PR" and the dataset
 * still appears in the tracking issue. A sweep must never fail because a
 * courtesy ping could not be addressed.
 */
async function resolvePullRequests(ids, byId) {
  const resolved = new Map();
  if (ids.length === 0) return resolved;

  const candidates = new Map(); // id -> Map<number, {number, url, updatedAt, state, source}>
  const remember = (id, pr, source) => {
    if (!pr?.number) return;
    if (!candidates.has(id)) candidates.set(id, new Map());
    const existing = candidates.get(id).get(pr.number);
    // Keep the first-recorded source: sources are consulted in priority order.
    if (existing) return;
    candidates.get(id).set(pr.number, {
      number: pr.number,
      url: pr.html_url ?? `https://github.com/${REPO_SLUG}/pull/${pr.number}`,
      updatedAt: pr.updated_at ?? null,
      state: pr.state ?? null,
      source,
    });
  };

  // (1) recorded provenance
  await mapLimit(ids, 8, async (id) => {
    try {
      const res = await fetch(`${DATA_BASE_URL}/${encodeURIComponent(id)}/stac/collection.json`, {
        headers: { "user-agent": "pointcloud-org-drift-sweep" },
      });
      if (!res.ok) return;
      const collection = await res.json();
      const ingest = collection?.["pointcloud_org:ingest"];
      const number = Number(ingest?.pull_request_number);
      if (Number.isInteger(number) && number > 0) {
        const pr = await gh(`/repos/${REPO_SLUG}/pulls/${number}`);
        remember(id, pr ?? { number }, "collection metadata");
      }
    } catch {
      // A dataset whose collection.json is unreachable is itself news, but
      // this function's only job is finding a PR.
    }
  });

  // (2) history of the manifest directory -> the newest commit that came from
  // a PR. Walks back rather than looking only at the tip: a maintainer fixing
  // a typo directly on main leaves a commit with no PR at all, and the useful
  // answer is still the PR that contributed the dataset. Two ways a commit
  // names its PR, tried in order:
  //
  //   - the associated-PRs endpoint, which knows about merge commits
  //   - the "(#123)" suffix GitHub's squash-merge writes into the subject,
  //     which is the only trace left once a squash lands on main
  await mapLimit(
    ids.filter((id) => !candidates.has(id)),
    4,
    async (id) => {
      const dir = path.posix.dirname(byId.get(id)?.file ?? `${MANIFEST_ROOT}/${id}/manifest.yaml`);
      const commits = await gh(`/repos/${REPO_SLUG}/commits?path=${encodeURIComponent(dir)}&per_page=10`);
      for (const commit of Array.isArray(commits) ? commits : []) {
        const prs = await gh(`/repos/${REPO_SLUG}/commits/${commit.sha}/pulls?per_page=10`);
        if (Array.isArray(prs) && prs.length > 0) {
          for (const pr of prs) remember(id, pr, "manifest history");
          return;
        }
        const squashed = /\(#(\d+)\)\s*$/m.exec((commit.commit?.message ?? "").split("\n")[0]);
        if (squashed) {
          const pr = await gh(`/repos/${REPO_SLUG}/pulls/${squashed[1]}`);
          if (pr?.number) {
            remember(id, pr, "squash-merge subject");
            return;
          }
        }
      }
    },
  );

  // (3) open PRs touching a broken dataset, fetched once for the whole sweep
  const open = await gh(`/repos/${REPO_SLUG}/pulls?state=open&per_page=100&sort=updated&direction=desc`);
  const brokenSet = new Set(ids);
  for (const pr of (Array.isArray(open) ? open : []).slice(0, 50)) {
    const files = await gh(`/repos/${REPO_SLUG}/pulls/${pr.number}/files?per_page=100`);
    for (const file of Array.isArray(files) ? files : []) {
      const match = /^manifests\/(?:.+\/)?([^/]+)\/[^/]+$/.exec(file.filename ?? "");
      const touched = match?.[1];
      if (touched && brokenSet.has(touched)) remember(touched, pr, "open pull request");
    }
  }

  for (const [id, byNumber] of candidates) {
    const best = [...byNumber.values()].sort((a, b) => {
      // Most recently updated first; an open PR breaks a tie against a merged
      // one, since that is where the conversation is actually happening.
      const stateRank = (pr) => (pr.state === "open" ? 1 : 0);
      if (stateRank(b) !== stateRank(a)) return stateRank(b) - stateRank(a);
      return String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? ""));
    })[0];
    if (best) resolved.set(id, best);
  }
  return resolved;
}

/** One attempt: HEAD, falling back to a ranged GET for hosts that refuse HEAD. */
async function headOnce(href) {
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

/**
 * Reachability of one URL, retried before it is believed.
 *
 * A single attempt is not evidence. The 2026-08-17 sweep reported `hk-2020`
 * unreachable on one `TypeError: fetch failed` against data.gov.hk, which
 * answered 200 on the next try from elsewhere -- a runner-side network blip,
 * not drift. That was already bad (it opens a tracking issue and names a
 * maintainer); now that a failure also comments on that maintainer's pull
 * request, crying wolf is expensive enough to spend a few seconds avoiding.
 *
 * Retries only what can plausibly be transient -- network/DNS/TLS errors,
 * timeouts, 429, and 5xx. A 404 is an answer: the server was reached and said
 * the thing is not there, so retrying it just slows the sweep down.
 */
async function head(href) {
  const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 509, 522, 524]);
  let last;
  for (let attempt = 0; attempt < RETRIES + 1; attempt += 1) {
    last = await headOnce(href);
    if (last.ok) return attempt === 0 ? last : { ...last, retries: attempt };
    const transient = last.status === 0 || RETRYABLE_STATUS.has(last.status);
    if (!transient) return last;
    if (attempt < RETRIES) await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * (attempt + 1)));
  }
  // Kept as the reason a maintainer sees, with the attempt count so a
  // "failed 3 times" report reads differently from a one-off.
  return { ...last, attempts: RETRIES + 1 };
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
              sampledAssets: d.sampledAssets,
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

  // Data failures decide the sweep's verdict; documentation-link failures are
  // reported separately and decide nothing. See SOURCE_LABELS/isDocLabel.
  const failuresByDataset = new Map();
  const docFailuresByDataset = new Map();
  for (const f of failures) {
    const bucket = isDocLabel(f.label) ? docFailuresByDataset : failuresByDataset;
    if (!bucket.has(f.datasetId)) bucket.set(f.datasetId, []);
    bucket.get(f.datasetId).push(f);
  }
  const parseErrors = datasetMeta.filter((d) => d.parseError);

  const hosted = datasetMeta.filter((d) => d.category === "hosted").length;
  const remote = datasetMeta.filter((d) => d.category === "remote").length;
  const totalUrls = datasetMeta.reduce((n, d) => n + (d.totalUrls ?? 0), 0);
  const brokenIds = [...new Set([...failuresByDataset.keys(), ...parseErrors.map((d) => d.id)])];
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const sampled = totalUrls > checked;

  const lines = [];
  const docNote =
    docFailuresByDataset.size > 0
      ? ` ${docFailuresByDataset.size} documentation link(s) also failed — see below; they do not affect the data.`
      : "";
  lines.push(
    brokenIds.length === 0
      ? `✅ **Reachability verified** — every dataset's data resolved, as of ${stamp}.${docNote}`
      : `⚠️ **Reachability: ${brokenIds.length} dataset(s) unreachable**, as of ${stamp}.${docNote}`,
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

  // Documentation links, reported either way -- as an advisory when nothing
  // else is wrong, and alongside the real breakage when there is some.
  const docLines = [];
  if (docFailuresByDataset.size > 0) {
    docLines.push("");
    docLines.push(`#### Documentation links — ${docFailuresByDataset.size} dataset(s)`);
    docLines.push("");
    docLines.push(
      "_A `license` or `about` link that no longer resolves. The data itself is unaffected, so this does not " +
        "fail the sweep or notify anyone — fix it whenever the manifest is next touched._",
    );
    docLines.push("");
    docLines.push("| Dataset | Link | Result |");
    docLines.push("| --- | --- | --- |");
    for (const [id, failed] of [...docFailuresByDataset.entries()].slice(0, MAX_ROWS)) {
      for (const f of failed) {
        const reason = f.result?.error ? f.result.error : `HTTP ${f.result?.status}`;
        const attempts = f.result?.attempts > 1 ? ` (${f.result.attempts} attempts)` : "";
        docLines.push(`| \`${id}\` | [\`${f.label}\`](${f.href}) | ${reason}${attempts} |`);
      }
    }
  }

  if (brokenIds.length === 0) {
    lines.push(...docLines);
    if (arg("json")) {
      writeFileSync(
        arg("json"),
        JSON.stringify({ ok: true, stamp, rows: [], documentationWarnings: docFailuresByDataset.size }, null, 2) + "\n",
      );
    }
    process.stdout.write(lines.join("\n") + "\n");
    process.exit(0);
  }

  // Which PR to point each broken dataset at. `--no-pr-lookup` keeps this
  // function testable offline and without a token.
  const pullRequests =
    process.argv.includes("--no-pr-lookup") ? new Map() : await resolvePullRequests(brokenIds, byId);

  /**
   * How a dataset's failures read in one table cell.
   *
   * The distinction that matters is whether the dataset is *gone* or
   * merely *damaged*:
   *
   *  - a failing critical URL (ept_source/stac_item/external_source)
   *    means the whole dataset is unresolvable, and that's the headline
   *  - every checked asset failing means the same thing in practice --
   *    the prefix moved or the bucket went away
   *  - a few assets failing out of many is a different, smaller problem
   *
   * Never enumerates individual assets. A dataset can list 10,000 tiles;
   * listing even the failing ones defeats the point of a scannable table
   * (and is how the original 11 KB comment happened). One representative
   * status plus a count is what a maintainer needs to decide whether to
   * look.
   */
  const describeFailures = (id, meta) => {
    if (meta.parseError) return "manifest failed to parse";
    const failed = failuresByDataset.get(id) ?? [];
    if (failed.length === 0) return "unknown";

    // Group by reason so "all 25 → HTTP 404" doesn't get reported as
    // "HTTP 404 (+24 more)" when the 24 are the same thing.
    // The attempt count matters to whoever reads this: "failed 3 times" is
    // drift, one failure is a coin toss (see head()'s retry note).
    const reasonOf = (f) => {
      const base = f.result?.error ? f.result.error : `HTTP ${f.result?.status}`;
      return f.result?.attempts > 1 ? `${base} (${f.result.attempts} attempts)` : base;
    };
    const reasons = new Map();
    for (const f of failed) reasons.set(reasonOf(f), (reasons.get(reasonOf(f)) ?? 0) + 1);
    const topReason = [...reasons.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const reasonSuffix = reasons.size > 1 ? ` (+${reasons.size - 1} other error type(s))` : "";

    const CRITICAL = new Set(["ept_source", "stac_item", "external_source"]);
    const criticals = failed.filter((f) => CRITICAL.has(f.label));
    if (criticals.length > 0) {
      return `**source unreachable** — \`${criticals[0].label}\` → ${reasonOf(criticals[0])}`;
    }

    // Assets compared against assets -- see sampledAssets' own comment. Clamped
    // so the denominator can never be smaller than the numerator: a report that
    // says "2 of 1" tells the reader the sweep is broken, not the dataset.
    const checkedAssets = Math.max(meta.sampledAssets ?? failed.length, failed.length);
    if (failed.length === 1) {
      return `1 asset (\`${failed[0].label}\`) → ${topReason}`;
    }
    if (failed.length >= checkedAssets && checkedAssets > 1) {
      return `**all ${checkedAssets} checked asset(s)** → ${topReason}${reasonSuffix}`;
    }
    return `${failed.length} of ${checkedAssets} checked asset(s) → ${topReason}${reasonSuffix}`;
  };

  // Grouped by owner: one subsection and table per maintainer, rather
  // than a single flat table sorted somehow. At 1000s of datasets a
  // maintainer's real question is "what of MINE is broken", and a shared
  // table forces them to scan a Maintainer column to answer it. The
  // Maintainer column is therefore gone -- the heading carries it.
  //
  // Most-affected owner first, matching the Notifications order below.
  const tableByOwner = new Map();
  for (const id of brokenIds) {
    const owner = byId.get(id)?.owner ?? null;
    if (!tableByOwner.has(owner)) tableByOwner.set(owner, []);
    tableByOwner.get(owner).push(id);
  }
  const orderedOwnerGroups = [...tableByOwner.entries()].sort((a, b) => b[1].length - a[1].length);

  let rowsEmitted = 0;
  for (const [owner, ids] of orderedOwnerGroups) {
    if (rowsEmitted >= MAX_ROWS) break;
    lines.push("");
    lines.push(`#### ${owner ? `@${owner}` : "No maintainer recorded"} — ${ids.length} unreachable`);
    lines.push("");
    lines.push("| Dataset | Reachability | Manifest | Last PR | Failing |");
    lines.push("| --- | :---: | --- | --- | --- |");
    for (const id of ids) {
      if (rowsEmitted >= MAX_ROWS) break;
      const meta = byId.get(id) ?? { id, file: "(unknown)", owner: null };
      const datasetLink = `[\`${id}\`](${SITE_BASE_URL}/datasets/${encodeURIComponent(id)}/)`;
      const manifestLink = `[\`${meta.file}\`](https://github.com/${REPO_SLUG}/blob/${REF_NAME}/${meta.file})`;
      const pr = pullRequests.get(id);
      const prCell = pr ? `[#${pr.number}](${pr.url})` : "—";
      lines.push(`| ${datasetLink} | ❌ | ${manifestLink} | ${prCell} | ${describeFailures(id, meta)} |`);
      rowsEmitted += 1;
    }
  }
  if (brokenIds.length > MAX_ROWS) {
    lines.push("");
    lines.push(`_…and ${brokenIds.length - MAX_ROWS} more, omitted to stay under GitHub's issue-body size limit._`);
  }

  // ---- Notifications ----
  //
  // Grouped BY OWNER, not one line per dataset. GitHub notifies a user
  // once per comment however many times they're mentioned, so a
  // per-dataset list would be pure noise -- and at this scale one owner
  // can plausibly own hundreds of broken datasets at once (an entire
  // USGS bucket reorganizing would do it).
  //
  // Placed below the table on purpose: the table is what a maintainer
  // scans, the mentions are what reaches whoever has to act.
  lines.push("");
  lines.push("### Notifications");
  lines.push("");

  const byOwner = new Map();
  const unowned = [];
  for (const id of brokenIds) {
    const owner = byId.get(id)?.owner;
    if (!owner) {
      unowned.push(id);
      continue;
    }
    if (!byOwner.has(owner)) byOwner.set(owner, []);
    byOwner.get(owner).push(id);
  }

  if (byOwner.size === 0 && unowned.length === 0) {
    lines.push("_No maintainers to notify._");
  }

  // Most-affected owner first, so the person with the biggest problem
  // reads their name at the top rather than hunting for it.
  const sortedOwners = [...byOwner.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [owner, ids] of sortedOwners) {
    // Cap the inline list; the table above is the authoritative detail,
    // and 200 backticked ids in one bullet is unreadable.
    const shown = ids.slice(0, 10).map((id) => `\`${id}\``).join(", ");
    const more = ids.length > 10 ? `, and ${ids.length - 10} more` : "";
    const noun = ids.length === 1 ? "dataset" : "datasets";
    lines.push(`- @${owner} — ${ids.length} unreachable ${noun}: ${shown}${more}`);
  }

  if (unowned.length > 0) {
    const shown = unowned.slice(0, 10).map((id) => `\`${id}\``).join(", ");
    const more = unowned.length > 10 ? `, and ${unowned.length - 10} more` : "";
    lines.push(
      `- ⚠️ **No maintainer recorded** for ${unowned.length} unreachable dataset(s): ${shown}${more}. ` +
        `Add a \`github_owner\` to the manifest's \`providers[].pointcloud_org.contact\` so future reports can ` +
        `notify someone.`,
    );
  }

  lines.push(...docLines);

  lines.push("");
  lines.push("**What to do about it**");
  lines.push("");
  lines.push("- If the data moved, update the manifest's URL in a pull request. Merging it re-ingests the dataset.");
  lines.push(
    "- If it's gone for good, delete the dataset directory. Merging de-indexes it; any archived copy in " +
      "pointcloud.org's own storage is kept regardless.",
  );
  lines.push("- If it was a transient outage, re-run the sweep and this report will clear itself.");

  // Machine-readable twin of the report above. `notify` consumes this rather
  // than re-deriving anything (or, worse, parsing the Markdown), and it is
  // also what the workflow renders into the job summary.
  if (arg("json")) {
    const rows = brokenIds.map((id) => {
      const meta = byId.get(id) ?? { id, file: "(unknown)", owner: null };
      const pr = pullRequests.get(id) ?? null;
      return {
        id,
        owner: meta.owner ?? null,
        manifest: meta.file,
        datasetUrl: `${SITE_BASE_URL}/datasets/${encodeURIComponent(id)}/`,
        manifestUrl: `https://github.com/${REPO_SLUG}/blob/${REF_NAME}/${meta.file}`,
        pullRequest: pr,
        failing: describeFailures(id, meta),
        parseError: meta.parseError ?? null,
      };
    });
    writeFileSync(
      arg("json"),
      JSON.stringify({ ok: false, stamp, checked, totalUrls, hosted, remote, rows }, null, 2) + "\n",
    );
  }

  process.stdout.write(lines.join("\n") + "\n");
  process.exit(1);
}

// ------------------------------------------------------------ withdraw
//
// Retracts a drift comment the sweep should not have posted. Its own mode
// rather than a flag on `notify`, because the run that retracts is by
// definition one whose report is clean -- there is no plan listing the dataset
// any more, so the PR has to be resolved from scratch.
//
// Comments are edited, never deleted: a false alarm that silently vanishes
// teaches nobody anything, and whoever read it deserves to see the correction
// in the same place.
if (mode === "withdraw") {
  const ids = (arg("ids") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (ids.length === 0) {
    console.error("withdraw: --ids <dataset,dataset> is required");
    process.exit(2);
  }
  const dryRun = process.argv.includes("--dry-run");
  const datasets = await loadDatasets();
  const byId = new Map(datasets.map((d) => [d.id, d]));
  const pullRequests = await resolvePullRequests(ids, byId);

  for (const id of ids) {
    const pr = pullRequests.get(id);
    if (!pr?.number) {
      console.log(`withdraw: no pull request found for "${id}" -- nothing to retract`);
      continue;
    }
    const marker = `<!-- upstream-drift:${id} -->`;
    const body = [
      marker,
      `✅ **Retracted:** the earlier drift report for \`${id}\` was a false alarm — its data is reachable.`,
      "",
      "The sweep was counting a failing `license`/`about` link (documentation, not data) as the dataset being " +
        "unreachable, and the doc hosts in question rate-limit CI runners. Documentation links are now reported " +
        "in their own advisory section and never notify anyone. Sorry for the noise.",
    ].join("\n");

    if (dryRun) {
      console.log(`--- would retract on #${pr.number} for ${id}`);
      console.log(body);
      continue;
    }
    const existing = await gh(`/repos/${REPO_SLUG}/issues/${pr.number}/comments?per_page=100`);
    const mine = (Array.isArray(existing) ? existing : []).find((c) => (c.body ?? "").includes(marker));
    if (!mine) {
      console.log(`withdraw: no sweep comment found on #${pr.number} for "${id}"`);
      continue;
    }
    const ok = await gh(`/repos/${REPO_SLUG}/issues/comments/${mine.id}`, { method: "PATCH", body: { body } });
    console.log(`withdraw: ${ok ? "retracted" : "FAILED to retract"} comment on #${pr.number} for ${id}`);
  }
  process.exit(0);
}

// -------------------------------------------------------------- notify
//
// Posts one comment per broken dataset on the PR that last touched it,
// tagging the manifest's github_owner. Separate from `report` so rendering is
// testable without a token, and so a failure to comment can never turn a
// successful sweep into a failed workflow.
//
// Idempotent: each comment carries an invisible marker keyed by dataset id, so
// a weekly sweep edits last week's comment in place instead of stacking a new
// one onto the same PR every Monday.
if (mode === "notify") {
  const planFile = arg("plan");
  if (!planFile) {
    console.error("notify: --plan <file> is required (produced by `report --json`)");
    process.exit(2);
  }
  const plan = JSON.parse(readFileSync(planFile, "utf-8"));
  const dryRun = process.argv.includes("--dry-run");

  if (plan.ok) {
    console.log("notify: sweep was clean, nothing to comment on");
    process.exit(0);
  }
  if (!GH_TOKEN && !dryRun) {
    console.error("notify: no GH_TOKEN in the environment -- skipping comments (the tracking issue still has it all)");
    process.exit(0);
  }

  const withPr = plan.rows.filter((r) => r.pullRequest?.number);
  const targets = withPr.slice(0, MAX_PR_COMMENTS);
  console.log(
    `notify: ${plan.rows.length} broken dataset(s); ${withPr.length} resolved to a PR; ` +
      `commenting on ${targets.length}${withPr.length > targets.length ? ` (capped at ${MAX_PR_COMMENTS})` : ""}`,
  );

  let posted = 0;
  let updated = 0;
  for (const row of targets) {
    const marker = `<!-- upstream-drift:${row.id} -->`;
    const mention = row.owner ? `@${row.owner} ` : "";
    const body = [
      marker,
      `⚠️ **\`${row.id}\` is unreachable upstream** — ${mention}this is the last pull request that touched it.`,
      "",
      `- **What failed:** ${row.failing}`,
      `- **Manifest:** [\`${row.manifest}\`](${row.manifestUrl})`,
      `- **Dataset page:** ${row.datasetUrl}`,
      `- **Checked:** ${plan.stamp}`,
      "",
      "If the data moved, update the manifest's URL in a pull request — merging it re-ingests the dataset. " +
        "If it is gone for good, delete the dataset directory. If this was a transient outage, the next weekly " +
        "sweep clears the report by itself.",
      "",
      `_Posted by the upstream-drift sweep. The full report lives in the [\`upstream-drift\`](https://github.com/${REPO_SLUG}/issues?q=is%3Aissue+label%3Aupstream-drift) tracking issue._`,
    ].join("\n");

    if (dryRun) {
      console.log(`--- would comment on #${row.pullRequest.number} (${row.pullRequest.source}) for ${row.id}`);
      console.log(body);
      continue;
    }

    const existing = await gh(`/repos/${REPO_SLUG}/issues/${row.pullRequest.number}/comments?per_page=100`);
    const mine = (Array.isArray(existing) ? existing : []).find((c) => (c.body ?? "").includes(marker));
    const result = mine
      ? await gh(`/repos/${REPO_SLUG}/issues/comments/${mine.id}`, { method: "PATCH", body: { body } })
      : await gh(`/repos/${REPO_SLUG}/issues/${row.pullRequest.number}/comments`, { method: "POST", body: { body } });
    if (result) {
      if (mine) updated += 1;
      else posted += 1;
      console.log(`notify: ${mine ? "updated" : "posted"} comment on #${row.pullRequest.number} for ${row.id}`);
    }
  }

  console.log(`notify: ${posted} new comment(s), ${updated} updated`);
  // Deliberately exit 0 even when some comments failed: the sweep's verdict is
  // the tracking issue, not whether every courtesy ping landed.
  process.exit(0);
}

console.error(
  `usage: reachability.mjs plan --shards N | check --shard I --shards N [--out FILE] | ` +
    `report --results DIR [--json FILE] [--no-pr-lookup] | ` +
    `notify --plan FILE [--dry-run] | withdraw --ids id,id [--dry-run]`,
);
process.exit(2);
