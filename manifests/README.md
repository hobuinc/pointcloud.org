# manifests/

Each subdirectory here is one dataset in the [pointcloud.org](https://pointcloud.org)
archive. `manifests/schema.json` is the canonical, machine-readable
schema for the `manifest.yaml` format below -- every manifest in this
directory validates against it (via `scripts/validate-manifests.mjs`
in CI), and so will yours.

## Adding a dataset

Each pull request may only add or edit **one** dataset directory under
`manifests/` -- CI rejects a PR that touches more than one (with a
comment explaining why), so a broken dataset never blocks review of an
unrelated one sharing the same PR. If you're editing more than one
dataset, open separate PRs.

1. Create a new directory `manifests/<dataset-id>/` (the directory name
   *is* the dataset id -- `dataset.id` inside `manifest.yaml` must match
   it exactly).
2. Add `manifests/<dataset-id>/manifest.yaml` describing it (see
   "Manifest reference" below, and the worked examples further down).
3. If your manifest references any companion files by a relative path
   (a `pdal_filters_file`, a locally-checked-in metadata PDF -- see
   below), put them in that same directory.
4. Open a pull request. CI (`scripts/validate-manifests.mjs`) validates
   your manifest against [`schema.json`](schema.json) plus a few checks
   schema.json can't express on its own (mostly: do the relative-path
   references you gave actually exist on disk), and a separate check
   confirms any foreign/https URL your manifest references is actually
   reachable.
5. Within a minute or two, a bot comment appears on your PR reporting
   the *real* checks against pointcloud.org's own infrastructure --
   see "How ingest actually happens" below. Push a fixup commit and it
   updates in place; you don't need to wait for a merge to find out
   your `assets_dir` prefix has a CRS mismatch or a `pdal_filters_file`
   has a typo'd option.
6. Once merged (and every check above is green), ingest starts for
   real.

## How ingest actually happens

![Diagram: a manifest PR flows through validation and preflight while open, then through ingest once merged](ingest-flow.svg)

This repo holds no ingest credentials at all -- the checks CI can run
directly here (schema shape, do relative-path references exist
locally, is a foreign/https URL reachable) need none, but anything that
actually has to ask pointcloud.org's storage backend something (does
this file exist, do these tiles share a coordinate system, does this
PDAL filter list parse) happens on pointcloud.org's own infrastructure,
which this repo's `.github/workflows/manifest-ingest.yml` reaches by
firing a generic "please check/ingest this dataset" dispatch event --
it holds no credentials for and knows nothing about how that
infrastructure is actually implemented. Two different dispatches fire
from the same workflow:

- **Preflight** (`manifest-preflight`) -- fires on every push to an
  open PR. Read-only: checks that referenced data files exist,
  `assets_dir` CRS consistency, and `pdal_filters`/`pdal_filters_file`
  validity, then reports pass/fail straight onto your PR as an
  updating comment plus a `pointcloud/*` commit status per check.
  Never enqueues anything, never emails anyone, however many times you
  push.
- **Ingest** (`manifest-ingest`) -- fires once, when the PR merges.
  Writes the manifest, enqueues real ingest, and posts its own
  outcome comment once the (same) checks resolve for real -- an
  `assets_dir` dataset's CRS check is asynchronous and can take a
  while for a large prefix, so this comment may land after the
  workflow run that triggered it has already finished.

If a preflight check ever seems stuck or wrong, look at the
`pointcloud/*` commit statuses on your PR's latest commit (next to the
usual CI checks) -- each one names exactly which check it is
(`pointcloud/file-existence`, `pointcloud/crs-consistency`,
`pointcloud/pdal-filters`).

## Manifest reference

### Required fields

```yaml
schema_version: 1

dataset:
  id: my-dataset             # must match the directory name
  title: My Dataset
  summary: A one-line summary. May contain Markdown.
  license: CC-BY-4.0
  derivatives: true           # generate DTM/DSM/ambient-occlusion COGs?
  providers:                  # at least one; at least one needs a contact
    - organization:
        name: Some Org
      contact:                # who gets emailed if ingest preflight fails
        name: Jane Doe
        email: jane@example.org
  tags: [some, tags]           # at least one

assets:                        # see "Describing the data" below
  - id: tile-001
    href: s3://pointcloud/my-dataset/tile-001.copc.laz
    roles: [data]
    copc:
      resolution: 1
```

### License

`license` is usually a plain identifier -- an [SPDX id](https://spdx.org/licenses/)
for a standard license (`CC0-1.0`, `CC-BY-4.0`, `CC-BY-SA-4.0`, ...) or
an [Open Data Commons](https://opendatacommons.org/licenses/) name for
a data-specific one (`ODC-By-1.0`, `ODbL-1.0`, `ODC-PDDL-1.0`), or
`PUBLICDOMAIN` when nothing more specific applies:

```yaml
dataset:
  license: CC-BY-4.0
```

Use the `{id, url}` object form instead when the license needs an
accompanying terms-of-use link -- e.g. USGS-sourced data, whose
public-domain status is qualified by USGS's own usage FAQ rather than
one canonical license text:

```yaml
dataset:
  license:
    id: "Public Domain (U.S. Government Work)"
    url: https://www.usgs.gov/faqs/what-are-terms-uselicensing-map-services-and-data-national-map
```

### Describing the data

Exactly one of these three:

- **`assets`** -- a hand-authored list, one entry per file. Use this
  when you have a small, fixed number of files, or when different files
  need different `label`/`copc.resolution` values.
- **`assets_dir`** -- for a batch of many same-CRS files already sitting
  under one prefix in our own bucket (`href` must start with
  `s3://pointcloud/`). Every matching file becomes its own asset
  automatically; before real ingest, every one of them is CRS-checked
  to confirm they actually share a coordinate system.
  ```yaml
  assets_dir:
    href: s3://pointcloud/my-dataset/
    pattern: "*.copc.laz"   # optional, this is the default
    roles: [data]
    copc:
      resolution: 3
  ```
- **`external_source`** -- a pointer into someone else's already-published
  STAC catalog (e.g. a USGS 3DEP EPT collection) rather than data we host
  ourselves. As of this writing this only produces a dry-run preview
  report, not a real ingest -- see `schema.json`'s description of this
  field.
  ```yaml
  external_source:
    href: https://example.org/some/item_collection.json
    expand: true
  ```

An individual asset's `href` can be:
- `s3://pointcloud/...` -- our own bucket.
- `s3://<other-bucket>/...` -- a bucket we don't own. See "Foreign
  buckets and endpoints" below.
- A bare `https://`/`http://` URL.
- A GDAL [Virtual File System](https://gdal.org/en/stable/user/virtual_file_systems.html)
  path (`/vsicurl/...`, `/vsis3/...`, etc.).

### Endpoints: discriminating which S3-compatible service hosts an asset

Every dataset's assets live *somewhere* -- a real AWS S3 bucket,
pointcloud.org's own bucket, someone else's S3-compatible bucket, or
any other S3-compatible service. `endpoint` (per-asset) and
`dataset.default_endpoint` (once, for the whole manifest, if every
asset shares one bucket/region -- saves repeating it) make that
explicit rather than inferred from the bucket name in `href`:

```yaml
dataset:
  default_endpoint: https://<account_id>.example-s3-service.com   # this project's own bucket

# or, per asset, for a bucket that isn't the default (e.g. someone
# else's S3-compatible bucket):
assets:
  - id: tile-001
    href: s3://someone-elses-bucket/tile-001.copc.laz
    endpoint: https://<account_id>.example-s3-service.com
    roles: [data]
    copc:
      resolution: 1
```

A real AWS S3 bucket in the default region (`us-east-1`) is the only
case where omitting this is safe -- that's the implicit fallback.
Anything else needs it set (here or via `default_endpoint`), or
resolution will silently produce a broken URL:

- A non-AWS S3-compatible bucket -- ours or anyone else's, including
  this repo's own `s3://pointcloud/...` assets, which every manifest
  sets `default_endpoint` for explicitly, purely so the manifest
  itself states which service+account hosts the data. It has no
  effect on retrieval for `s3://pointcloud/...` specifically -- that's
  always fetched directly by pointcloud.org's own infrastructure,
  never over a public HTTP endpoint.
- An AWS S3 bucket outside the default region -- e.g. USGS 3DEP EPT
  data on `usgs-lidar-public`, which lives in `us-west-2`.

### Optional dataset fields

```yaml
dataset:
  description: >
    Longer Markdown description, rendered on the dataset's page. Or,
    instead of inline text, a bare relative filename ending in ".md"
    (e.g. "description.md") checked into this manifest's own directory
    -- use that for anything longer than a paragraph or two.
  publication_date: 2021-06-01   # when published, vs. temporal (when acquired)
  temporal:
    start: 2020-03-01
    end: 2020-09-30
  overview_image: s3://pointcloud/my-dataset/overview.jpg   # or a bare https:// URL
  viewer:
    default_asset_id: tile-001
  metadata_links:                 # pointers to flight reports, sensor docs, etc.
    - title: Flight report
      href: https://example.org/reports/my-dataset.pdf       # remote, OR:
    - title: Local acquisition notes
      href: acquisition-notes.pdf                             # relative to this manifest's own directory
  federate: true   # copy this dataset's data into pointcloud.org's own storage at ingest time
```

`federate: true` (default false; only meaningful alongside a
hand-authored `assets` list) tells ingest to copy every asset's bytes
from wherever this manifest currently points into pointcloud.org's own
storage once, at ingest time, rather than continuing to read from the
original source on every later access. Use it when a dataset's source
host isn't reliably durable long-term (a personal server, a
time-limited hosting arrangement) and the intent is to actually archive
a copy here. A PR whose manifest sets this gets a `federate` label and
a comment calling it out, since it's a meaningfully different
commitment than the default (link out, don't copy).

A `metadata_links[].href` may be a plain relative filename -- put the
file in `manifests/<dataset-id>/` alongside `manifest.yaml`, and the
site build copies it into its own static output and links to it from
pointcloud.org's own domain. No relative-path support is needed for
`overview_image` -- that one's resolved the same way `assets[].href` is
(our bucket / a foreign bucket+endpoint / a bare URL).

### Overriding derivative generation

Only consulted when `dataset.derivatives: true`. Every field is
optional; omit anything to use the engine's default.

```yaml
derivative_processing:
  resolution: 1.0   # GSD in meters, overrides each asset's copc.resolution for derivatives only
  dtm:
    enabled: true
    pdal_filters:                        # inline, OR:
      - type: filters.range
        limits: "Classification[2:2]"
    pdal_filters_file: dtm-filters.json  # a path relative to this manifest's own directory
  dsm:
    enabled: true
  ambient_occlusion:
    enabled: true
```

`pdal_filters`/`pdal_filters_file` are mutually exclusive (pick one).
Either way, only give filter *stages* -- no reader (the engine picks one
based on the source file type) and no writer (the engine always appends
its own `writers.gdal` stage, configured from `resolution`). See
[`hk-2020/manifest.yaml`](hk-2020/manifest.yaml) and its sibling
[`hk-2020/dtm-filters.json`](hk-2020/dtm-filters.json) for a real,
working example of the file form.

## Worked examples

- [`hk-2020/`](hk-2020/) -- `assets_dir` (many same-CRS files under one
  prefix), multiple `providers` (producer + separate host), and a
  `pdal_filters_file`.
- [`wi-adams-2019/manifest.yaml`](wi-adams-2019/manifest.yaml) -- a
  hand-authored `assets` list with many individually-labeled tiles.
- [`barringer-meteorite-crater/manifest.yaml`](barringer-meteorite-crater/manifest.yaml) --
  a minimal single-asset manifest with a `links`/citation entry.

## Removing a dataset

Delete the whole `manifests/<dataset-id>/` directory and open a PR. This
repo automatically detects that the PR removes a dataset (rather than
adding or editing one), labels it `removal`, and posts a comment
explaining what merging it will do -- one dataset per PR applies to a
removal exactly like it does to an addition or edit, so a removal PR
can't be bundled with unrelated changes.

Once merged, the dataset is removed from pointcloud.org's site listing
and from the root STAC Catalog. Its underlying point-cloud data is
**not** deleted -- removing a dataset here only removes it from the
*index* (the site and STAC output), the archived data itself stays in
storage.

## License

Manifests describe third-party datasets; each dataset's `license` field
states the terms of the underlying data, which may differ from this
repo's own license.
