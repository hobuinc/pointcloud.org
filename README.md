# pointcloud.org

A public archive of [Cloud Optimized Point Cloud](https://copc.io) (COPC)
lidar datasets, each with STAC metadata and an in-browser 3D viewer, at
[pointcloud.org](https://pointcloud.org).

This repo holds the dataset manifests that describe what's in the
archive. All ingest, build, and deploy automation lives in a separate,
private repo -- this one is just the community-facing catalog.

## Adding a dataset

Open a pull request adding a new `manifests/<dataset-id>.yaml` file.
Each manifest needs:

- `schema_version: 1`
- `dataset.id`, `dataset.title`, `dataset.summary`, `dataset.license`
- `dataset.tags` -- at least one
- `dataset.maintainer.name` and `dataset.maintainer.email` -- who to
  contact if something's wrong with the data (a coordinate-system
  mismatch, a broken file, etc.)
- `dataset.derivatives` -- `true`/`false`
- Either an `assets` list (one entry per file, each with `id`, `href`,
  `roles`, `copc.resolution`) or an `assets_dir` block (`href`,
  `roles`, `copc.resolution`, optional `pattern`) for a whole directory
  of same-CRS files

See any existing file in `manifests/` for a full example.

Every PR runs `scripts/validate-manifests.mjs` in CI, which checks all
of the above is present. Once merged, ingest starts automatically --
your maintainer email gets a notice if anything about the source data
fails a preflight check (e.g. mixed coordinate systems in an
`assets_dir`).

## License

Manifests describe third-party datasets; each dataset's `license`
field states the terms of the underlying data, which may differ from
this repo's own license.
