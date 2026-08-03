# manifests/

Each subdirectory here is one dataset in the [pointcloud.org](https://pointcloud.org)
archive. `manifests/schema.json` is the canonical, machine-readable
schema for the `manifest.yaml` format below -- every manifest in this
directory validates against it (via `scripts/validate-manifests.mjs`
in CI), and so will yours.

## Adding a dataset

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
   references you gave actually exist on disk).
5. Once merged and CI's validation job is green, ingest starts
   automatically. If anything about the source data itself fails a
   preflight check (e.g. mixed coordinate systems under an `assets_dir`
   prefix), your dataset's primary contact (see `providers[].contact`
   below) gets an email -- nothing is left partially ingested.

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

### Describing the data

Exactly one of these three:

- **`assets`** -- a hand-authored list, one entry per file. Use this
  when you have a small, fixed number of files, or when different files
  need different `label`/`copc.resolution` values.
- **`assets_dir`** -- for a batch of many same-CRS files already sitting
  under one prefix in our own R2 bucket (`href` must start with
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

Every dataset's assets live *somewhere* -- a real AWS S3 bucket, this
project's own Cloudflare R2 bucket, someone else's R2 bucket, or any
other S3-compatible service. `endpoint` (per-asset) and
`dataset.default_endpoint` (once, for the whole manifest, if every
asset shares one bucket/region -- saves repeating it) make that
explicit rather than inferred from the bucket name in `href`:

```yaml
dataset:
  default_endpoint: https://c88d624d8d8f065b1afce73bd44dcf1d.r2.cloudflarestorage.com   # this project's own R2 account

# or, per asset, for a bucket that isn't the default (e.g. someone
# else's Cloudflare R2 bucket):
assets:
  - id: tile-001
    href: s3://someone-elses-bucket/tile-001.copc.laz
    endpoint: https://<account_id>.r2.cloudflarestorage.com
    roles: [data]
    copc:
      resolution: 1
```

A real AWS S3 bucket in the default region (`us-east-1`) is the only
case where omitting this is safe -- that's the implicit fallback.
Anything else needs it set (here or via `default_endpoint`), or
resolution will silently produce a broken URL:

- A Cloudflare R2 bucket -- ours or anyone else's, including this
  repo's own `s3://pointcloud/...` assets, which every manifest sets
  `default_endpoint` for explicitly, purely so the manifest itself
  states which account hosts the data. It has no effect on retrieval
  for `s3://pointcloud/...` specifically -- that's always fetched via
  a native R2 binding, never over HTTP.
- An AWS S3 bucket outside the default region -- e.g. USGS 3DEP EPT
  data on `usgs-lidar-public`, which lives in `us-west-2`.

### Optional dataset fields

```yaml
dataset:
  description: >
    Longer Markdown description, rendered on the dataset's page.
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
```

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

## License

Manifests describe third-party datasets; each dataset's `license` field
states the terms of the underlying data, which may differ from this
repo's own license.
