# pointcloud.org

A public archive of [Cloud Optimized Point Cloud](https://copc.io) (COPC)
lidar datasets, each with STAC metadata and an in-browser 3D viewer, at
[pointcloud.org](https://pointcloud.org).

This repo holds the dataset manifests that describe what's in the
archive. All ingest, build, and deploy automation lives in a separate,
private repo (`pointcloud.org-infrastructure`) -- this one is just the
community-facing catalog: anyone can open a PR here to add or edit a
dataset.

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
   your manifest against [`manifests/schema.json`](manifests/schema.json)
   -- the canonical, machine-readable schema for this format -- plus a
   few checks schema.json can't express on its own (mostly: do the
   relative-path references you gave actually exist on disk).
5. Once merged and CI's validation job is green, ingest starts
   automatically. If anything about the source data itself fails a
   preflight check (e.g. mixed coordinate systems under an `assets_dir`
   prefix), your dataset's primary contact (see `providers[].contact`
   below) gets an email -- nothing is left partially ingested.

`manifests/schema.json` is the source of truth if anything below is
unclear or out of date -- every manifest in this repo validates against
it, and so will yours.

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
  report, not a real ingest -- see `manifests/schema.json`'s description
  of this field.
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

### Foreign buckets and endpoints

If an asset's `href` points at an `s3://` bucket you don't own, and that
bucket **isn't** a standard AWS S3 bucket in the default region, set
`endpoint` (per-asset) or `dataset.default_endpoint` (once, for the
whole manifest, if every foreign asset shares one bucket/region --
saves repeating it):

```yaml
dataset:
  default_endpoint: https://s3.us-west-2.amazonaws.com   # an AWS region other than us-east-1

# or, per asset, for a Cloudflare R2 bucket someone else owns:
assets:
  - id: tile-001
    href: s3://someone-elses-bucket/tile-001.copc.laz
    endpoint: https://<account_id>.r2.cloudflarestorage.com
    roles: [data]
    copc:
      resolution: 1
```

Omitting this for a real AWS bucket in `us-east-1` is fine (that's the
implicit default); omitting it for anything else -- Cloudflare R2, or
AWS outside `us-east-1` -- will silently produce a broken URL.

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
`manifests/hk-2020/manifest.yaml` and its sibling
`manifests/hk-2020/dtm-filters.json` for a real, working example of the
file form.

## Worked examples

- [`manifests/hk-2020/`](manifests/hk-2020/) -- `assets_dir` (many
  same-CRS files under one prefix), multiple `providers` (producer +
  separate host), and a `pdal_filters_file`.
- [`manifests/wi-adams-2019/manifest.yaml`](manifests/wi-adams-2019/manifest.yaml) --
  a hand-authored `assets` list with many individually-labeled tiles.
- [`manifests/barringer-meteorite-crater/manifest.yaml`](manifests/barringer-meteorite-crater/manifest.yaml) --
  a minimal single-asset manifest with a `links`/citation entry.

## License

Manifests describe third-party datasets; each dataset's `license` field
states the terms of the underlying data, which may differ from this
repo's own license.
