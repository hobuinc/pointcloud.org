# manifests/

Each directory here is one dataset in the [pointcloud.org](https://pointcloud.org)
archive. `manifests/schema.json` is the canonical, machine-readable
schema for the `manifest.yaml` format below -- every manifest in this
directory validates against it (via `scripts/validate-manifests.mjs`
in CI), and so will yours.

As of schema_version 2 (2026-08), a manifest's own field vocabulary is
aligned directly with [STAC](https://stacspec.org/) -- a manifest reads
as a (partial) STAC Collection, whose `items`/`items_dir`/`stac_item`/
`external_source`/`ept_source` become its child Items at ingest time. Only
pointcloud.org-ingest-specific concerns with no STAC equivalent
(derivatives, federate, viewer settings, ...) live under the nested
`pointcloud_org` object -- everything else is a real, if partial, STAC
Collection field. If you already know STAC, most of this file needs no
legend.

## Adding a dataset

**One dataset per pull request.** CI rejects a PR that touches more than one
directory under `manifests/` (with a comment saying so), so a broken dataset
never blocks review of an unrelated one. Changing several? Open several PRs.

Four steps, and you only do the first two:

1. **Create `manifests/<dataset-id>/manifest.yaml`.** The directory name *is*
   the dataset id: `id` inside the file must match it exactly, and must be
   unique across the whole repo even under a different grouping directory.
   See [what a manifest needs](#at-a-glance-what-a-manifest-needs) below.
2. **Put companion files in that same directory** — anything the manifest
   names by relative path, such as a `pdal_filters_file` or a metadata PDF.
3. **Open the pull request.** Checks that need no credentials run at once;
   within a minute or two a bot comment reports the real checks against
   pointcloud.org's own storage. Push fixups until it is green — that comment
   updates in place rather than piling up.
4. **A maintainer merges it**, and ingest runs itself. Merging is the only
   step in the entire path that needs a human decision.

Not sure a field is right? You do not have to get it right first try — open
the PR and let the checks tell you. `scripts/validate-manifests.mjs` reports
schema problems and missing companion files before a human looks at it.

(Maintainers only: a PR whose title contains `[migration]` is exempt from the
one-dataset rule and validates every manifest in the repo instead of just the
diff, for schema changes that must touch all of them. It is not a way to
bundle datasets — a multi-dataset `[migration]` PR gets no preflight and
triggers no ingest on merge.)

This is [conda-forge](https://conda-forge.org/)'s pattern applied to data: one
recipe, one pull request, reviewed and built in the open. See
[Why it works this way](#why-it-works-this-way).

## Grouping datasets into directories

A dataset directory may be nested one or more levels under an arbitrary
grouping directory, instead of sitting directly under `manifests/` --
e.g. `manifests/usgs-3dep/boston-lot/manifest.yaml` groups `boston-lot`
under `usgs-3dep`, alongside however many other USGS 3DEP datasets get
added the same way. This is purely organizational: `id` is still always
just the leaf directory name (`boston-lot`, not `usgs-3dep/boston-lot`),
globally unique across the whole repo regardless of nesting depth --
grouping doesn't change R2 key prefixes, site routes, or STAC catalog
ids. The grouping segment itself is never authored inside
`manifest.yaml` -- it's derived automatically from the directory path
and surfaced as a `pointcloud_org:group` property on the assembled STAC
Collection.

There's no need to create a grouping directory up front for a single
dataset -- start it directly under `manifests/` (like every existing
dataset today) and only nest it once a second, related dataset shows up.

## How ingest actually happens

![Diagram: nine numbered steps. Steps one to five repeat on every push while the pull request is open -- open a PR, credential-free CI checks, GitHub's signed webhook, the real checks against storage, answers posted back on the PR. Steps six to nine fire once at merge -- merge, read every asset, assemble the STAC record, publish.](ingest-flow.svg)

Two things drive the pipeline, and the split between them is what is worth
understanding.

**This repo's own CI** (`.github/workflows/manifest-check.yml`) runs only the
checks that need no credentials: schema shape, do relative-path references
exist on disk, is a `github_owner` named, is every foreign URL reachable, and
is this really one dataset. Safe for a fork's PR, because there is nothing
here to steal.

**pointcloud.org's own infrastructure** does everything that needs storage
access. GitHub delivers the pull-request event to it directly as a signed
webhook, which it verifies before acting on:

- **While your PR is open** (every push) it runs the read-only checks — do the
  referenced files exist, are `items_dir` tiles CRS-consistent, do the
  `pdal_filters` parse — and reports them as one updating comment plus a
  `pointcloud/*` commit status per check. Nothing is enqueued and nobody is
  emailed, however many times you push.
- **When your PR merges** (once) it enqueues the real work, then posts its
  outcome: first that the assets are queued, then the same comment updated
  with point count, size, license and a link to the live dataset page. An
  `items_dir` CRS check is asynchronous, so for a large prefix that comment
  can land well after the merge.

**No credential lives in this repo, and no CI runner holds one either.** The
webhook is authenticated by GitHub signing the delivery and pointcloud.org
verifying that signature, so there is nothing in between to trust. Until
2026-08-19 this hop went through a private relay repository; removing it
deleted two GitHub Actions workflows and, more importantly, a failure mode
where the relay could stop running while every check here still went green.

If a preflight check ever seems stuck or wrong, look at the
`pointcloud/*` commit statuses on your PR's latest commit (next to the
usual CI checks) -- each one names exactly which check it is
(`pointcloud/file-existence`, `pointcloud/crs-consistency`,
`pointcloud/pdal-filters`).

### Why it works this way

The design is lifted from [conda-forge](https://conda-forge.org/),
which solved the same social problem for software packages: how do you
let anyone contribute to a shared, trusted collection without handing
them the keys to it?

| conda-forge | here |
| --- | --- |
| A recipe describes a package; the build happens on CI | A manifest describes a dataset; the ingest happens on CI |
| One recipe per feedstock, one change per PR | One dataset directory per PR |
| Maintainers review; bots do the mechanical work | Same -- every check, label, and comment on your PR is automated |
| `@conda-forge-admin, please ...` commands | `@pointcloud-org, please ...` commands (see below) |
| Contributors never hold the signing/upload keys | Contributors never hold the storage credentials |

The consequence worth internalising: **the pull request is the unit of
work.** Not a form, not a ticket, not an email to a data manager. If
you want something to happen -- a dataset added, re-ingested, removed,
its metadata corrected -- it happens as a reviewable diff, and the
history of every dataset in the archive is `git log`.

## Manifest reference

### At a glance: what a manifest needs

Nine top-level fields are required, plus **exactly one** way of pointing at
the data, plus one `pointcloud_org` key. Everything else is optional.

| | Field | Notes |
| --- | --- | --- |
| **required** | `schema_version` · `type` · `stac_version` | Fixed markers. Copy them from any [worked example](#worked-examples) |
| **required** | `id` | Must equal this manifest's own directory name |
| **required** | `title` · `description` · `keywords` | `description` may instead be a bare `*.md` filename sitting in the same directory |
| **required** | `license` | An SPDX string, or an object when the terms need a link — see [License](#license) |
| **required** | `providers[]` | Each entry needs `name`. At least one must carry `pointcloud_org.contact` with `name`, `email` and **`github_owner`** — see [below](#github_owner-is-required-on-every-manifest) |
| **required** | `pointcloud_org.derivatives` | `true` or `false`: build DTM/DSM/ambient-occlusion rasters at ingest or not |
| **required — pick exactly one** | `items` · `items_dir` · `stac_item` · `external_source` · `ept_source` | Mutually exclusive; the schema rejects a manifest naming two. See [Describing the data](#describing-the-data) |
| optional | `extent.temporal` · `sci:doi` · `sci:citation` · `sci:publications` · `links` · `assets` | Standard STAC fields, passed straight through — see [Optional top-level fields](#optional-top-level-fields) |
| optional | `pointcloud_org.federate` · `default_endpoint` · `derivative_processing` · `spatial_reference` · `acknowledgement` · `publication_date` · `metadata_links` · `viewer` | See [Optional `pointcloud_org` fields](#optional-pointcloud_org-fields) |

Within the source you pick: an `items[]` entry needs `id` and `assets`, plus
`pointcloud_org.copc_resolution`; an `items_dir` needs `href` and `roles`; the
other three need only `href`.

Everything in the "optional" rows is genuinely optional — a manifest with the
required fields and one `ept_source` is a complete, publishable dataset. The
optional fields buy better provenance on the dataset page, not a successful
ingest.


### Required fields

```yaml
schema_version: 2
type: Collection
stac_version: "1.0.0"

id: my-dataset             # must match the directory name, globally unique
title: My Dataset
description: A one-line (or longer) description. May contain Markdown.
license: CC-BY-4.0

keywords: [lidar, some, tags]   # at least one

providers:                  # at least one; at least one needs a contact
  - name: Some Org
    pointcloud_org:
      contact:
        name: Jane Doe
        email: jane@example.org
        github_owner: janedoe   # GitHub username -- see below, this one is mandatory

pointcloud_org:
  derivatives: true          # generate DTM/DSM/ambient-occlusion COGs?

items:                        # see "Describing the data" below
  - id: tile-001
    assets:
      data:
        href: s3://pointcloud/my-dataset/tile-001.copc.laz
        roles: [data]
    pointcloud_org:
      copc_resolution: 1
```

`keywords` is STAC's term for schema_version 1's `tags`; at least one is
required, and they drive the tag filtering on the site's catalog page.

### `github_owner` is required, on every manifest

At least one `providers[]` entry must carry a
`pointcloud_org.contact` with all three of `name`, `email`, and
`github_owner`. Validation fails outright without a `github_owner` --
there is no dataset in the archive that doesn't name one.

It is the account automation @-mentions when this dataset needs a human:
most often when a weekly sweep finds that data the manifest points at
has stopped being reachable upstream. Naming yourself does **not** claim
responsibility for the upstream data, and does not imply you produced
it -- only that you are the person to ask about *this manifest*. For a
dataset you're contributing but don't own the data for, you are still
the right `github_owner`.

### License

`license` is usually a plain identifier -- an [SPDX id](https://spdx.org/licenses/)
for a standard license (`CC0-1.0`, `CC-BY-4.0`, `CC-BY-SA-4.0`, ...) or
an [Open Data Commons](https://opendatacommons.org/licenses/) name for
a data-specific one (`ODC-By-1.0`, `ODbL-1.0`, `ODC-PDDL-1.0`), or
`PUBLICDOMAIN` when nothing more specific applies:

```yaml
license: CC-BY-4.0
```

Use the `{id, url}` object form instead when the license needs an
accompanying terms-of-use link -- e.g. USGS-sourced data, whose
public-domain status is qualified by USGS's own usage FAQ rather than
one canonical license text:

```yaml
license:
  id: "Public Domain (U.S. Government Work)"
  url: https://www.usgs.gov/faqs/what-are-terms-uselicensing-map-services-and-data-national-map
```

`license` becomes the assembled STAC Collection's own `license` field
(`id`, if the object form was used) plus a `rel: license` Link (`url`,
if given) -- the standard STAC way to attach a license URL.

### Describing the data

Exactly one of these five -- they're mutually exclusive, and the schema
enforces that:

- **`items`** -- a hand-authored list, one entry per file, each shaped
  like a minimal STAC Item. Use this when you have a small, fixed
  number of files, or when different files need different `title`/
  `pointcloud_org.copc_resolution` values.
  ```yaml
  items:
    - id: tile-001
      title: Optional per-item title, distinct from the dataset title
      assets:
        data:
          href: s3://pointcloud/my-dataset/tile-001.copc.laz
          roles: [data]
      pointcloud_org:
        copc_resolution: 1
  ```
- **`items_dir`** -- for a batch of many same-CRS files already sitting
  under one prefix in our own bucket (`href` must start with
  `s3://pointcloud/`). Every matching file becomes its own item
  automatically; before real ingest, every one of them is CRS-checked
  to confirm they actually share a coordinate system.
  ```yaml
  items_dir:
    href: s3://pointcloud/my-dataset/
    pattern: "*.copc.laz"   # optional, this is the default
    roles: [data]
    pointcloud_org:
      copc_resolution: 3
  ```
- **`stac_item`** -- a pointer to a contributor's own already-complete
  STAC Item document (geometry, bbox, `pc:*`/`proj:*` properties,
  assets already filled in), instead of retyping that same information
  by hand. Its `assets` map supplies the asset href/type/roles (looking
  for a `"data"`-role asset, falling back to the first asset if none is
  explicitly marked).
  ```yaml
  stac_item:
    href: https://example.org/stac/my-item.json
    pointcloud_org:
      copc_resolution: 1   # optional override; falls back to a conservative default
  ```
- **`external_source`** -- a pointer into someone else's already-published
  STAC Catalog/ItemCollection rather than data we host ourselves, when
  that document's own child Items/Collections should each become their
  own separate pointcloud.org dataset (`expand: true`). As of this
  writing this only produces a dry-run preview report, not a real
  ingest -- see `schema.json`'s description of this field. For a single
  EPT resource (one dataset, not an expand-style catalog of many), use
  `ept_source` below instead.
  ```yaml
  external_source:
    href: https://example.org/some/item_collection.json
    expand: true
  ```
- **`ept_source`** -- a single [Entwine Point Tile](https://entwine.io/entwine-point-tile.html)
  (EPT) resource -- e.g. one project out of USGS 3DEP's EPT catalog --
  read directly via PDAL's `readers.ept` and displayed in-browser via
  Eptium's native EPT support. Never copied into our own bucket (no
  `federate` support) and never converted to COPC, since an EPT
  resource is a multi-file hierarchy (`ept.json` + `ept-data/` +
  `ept-hierarchy/`), not one downloadable file. `href` must end in
  `ept.json` -- that's the exact suffix both PDAL's and Eptium's own
  auto-detection key off of.
  ```yaml
  ept_source:
    href: https://s3-us-west-2.amazonaws.com/usgs-lidar-public/my-project/ept.json
    ept_catalog_id: USGS_LPC_My_Project_2021  # optional; if set, also used to look up
                                               # real start_datetime/end_datetime from
                                               # USGS's WESM CSV at ingest time (an
                                               # ept.json root document has no
                                               # acquisition-date field of its own)
    pointcloud_org:
      copc_resolution: 1   # optional override; falls back to a conservative default
  ```

An individual item's `assets.data.href` can be:
- `s3://pointcloud/...` -- our own bucket.
- `s3://<other-bucket>/...` -- a bucket we don't own. See "Foreign
  buckets and endpoints" below.
- A bare `https://`/`http://` URL.
- A GDAL [Virtual File System](https://gdal.org/en/stable/user/virtual_file_systems.html)
  path (`/vsicurl/...`, `/vsis3/...`, etc.).

### Endpoints: discriminating which S3-compatible service hosts an asset

Every dataset's assets live *somewhere* -- a real AWS S3 bucket,
pointcloud.org's own bucket, someone else's S3-compatible bucket, or
any other S3-compatible service. `assets.data.endpoint` (per-item) and
`pointcloud_org.default_endpoint` (once, for the whole manifest, if
every item shares one bucket/region -- saves repeating it) make that
explicit rather than inferred from the bucket name in `href`:

```yaml
pointcloud_org:
  default_endpoint: https://<account_id>.example-s3-service.com   # this project's own bucket

# or, per item, for a bucket that isn't the default (e.g. someone
# else's S3-compatible bucket):
items:
  - id: tile-001
    assets:
      data:
        href: s3://someone-elses-bucket/tile-001.copc.laz
        endpoint: https://<account_id>.example-s3-service.com
        roles: [data]
    pointcloud_org:
      copc_resolution: 1
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

### Optional top-level fields

```yaml
keywords: [some, tags]

links:
  - rel: cite-as
    href: https://doi.org/10.5555/example

extent:
  temporal:
    interval:
      - ["2020-03-01", "2020-09-30"]   # or [null, null]/partial for open-ended

"sci:doi": "10.5555/example"           # bare DOI, not a full URL
"sci:citation": >
  How this dataset itself should be cited. May contain Markdown.
"sci:publications":                     # other publications that used this dataset
  - citation: >
      Doe, J. (2020). A paper that used this dataset.
    doi: "10.5555/other-example"        # optional, per-publication

assets:
  thumbnail:
    href: s3://pointcloud/my-dataset/overview.jpg   # or a bare https:// URL
```

`extent.temporal.interval` is STAC's own shape -- an array of `[start,
end]` pairs, each bound an ISO 8601 date/timestamp or `null` for
open-ended. Unlike schema_version 1's `dataset.temporal.start`/`.end`,
there's no separate bare-date convenience form; a plain `YYYY-MM-DD`
still works (STAC/YAML both treat it as a valid date literal), it's
just written directly in STAC's array shape.

`"sci:doi"`/`"sci:citation"`/`"sci:publications"` are the STAC
[Scientific Citation extension](https://github.com/stac-extensions/scientific)
-- quote the keys in YAML since they contain a colon. `sci:citation` is
separate from `links`' `rel: cite-as` entry: `cite-as` is a single
canonical machine-readable DOI link, while `sci:citation` is
human-readable attribution text (the dataset's own citation) rendered
as-is on the dataset's page; `sci:publications` covers other papers that
used the dataset, distinct from citing the dataset itself.

`assets` is STAC's own Collection-level assets map -- `thumbnail` is the
conventional key for a representative overview image, replacing
schema_version 1's dedicated `overview_image` field with the real STAC
convention for exactly this case. No relative-path support is needed
for it -- it's resolved the same way an item's own `assets.data.href`
is (our bucket / a foreign bucket+endpoint / a bare URL).

### Optional `pointcloud_org` fields

Everything below is pointcloud.org-ingest-specific and has no STAC
equivalent, which is why it's nested under `pointcloud_org` rather than
sitting at the top level alongside the STAC-native fields above.

```yaml
pointcloud_org:
  publication_date: 2021-06-01   # when published, vs. extent.temporal (when acquired)
  viewer:
    default_asset_id: tile-001
  metadata_links:                 # pointers to flight reports, sensor docs, etc.
    - title: Flight report
      href: https://example.org/reports/my-dataset.pdf       # remote, OR:
    - title: Local acquisition notes
      href: acquisition-notes.pdf                             # relative to this manifest's own directory
  federate: true   # copy this dataset's data into pointcloud.org's own storage at ingest time
  acknowledgement: >
    Funding text a data provider asks to be included whenever this
    dataset is used, e.g. a granting agency and award number.
  spatial_reference:
    id: "EPSG:26912"                                   # only when the source metadata states one explicitly
    vertical_id: "EPSG:5703"                            # optional, if documented separately
    url: https://spatialreference.org/ref/epsg/26912/   # only when id resolves to a real reference page
```

`spatial_reference` is purely informational -- it doesn't feed any
ingest-time CRS handling (that comes from the data itself, and from
`items_dir`'s CRS-consistency preflight check). Only set it when the
source metadata for a dataset states an explicit id (an EPSG code is
the common case); don't guess one from the data. Only set `url` when
that id actually resolves to a reference page, e.g.
`https://spatialreference.org/ref/epsg/<code>/` for an EPSG code.

`federate: true` (default false; meaningful alongside a hand-authored
`items` list -- ignored for `items_dir`/`external_source`, and refused
outright for `stac_item`, see below) tells ingest to copy every asset's
bytes from wherever this manifest currently points into pointcloud.org's
own storage once, at ingest time, rather than continuing to read from
the original source on every later access. Use `federate`
when a dataset's source host isn't reliably durable long-term (a
personal server, a time-limited hosting arrangement) and the intent is
to actually archive a copy here. A PR whose manifest sets this gets a
`federated` label and a comment calling it out (including an estimated
size, in GB, of what will be copied), since it's a meaningfully
different commitment than the default (link out, don't copy).

Two limits on what may be copied. First, a format allowlist: only
`.copc.laz`, `.laz`, `.las`, `.tif`, and `.tiff` assets can be
federated, and CI fails the PR (naming each offending href) otherwise --
this archive stores point clouds and rasters, not arbitrary files
fetched from arbitrary URLs. Second, `federate` cannot be combined with
`stac_item`: the filenames to be copied aren't knowable from the
manifest alone in that form.

A `metadata_links[].href` may be a plain relative filename -- put the
file in `manifests/<dataset-id>/` alongside `manifest.yaml`, and the
site build copies it into its own static output and links to it from
pointcloud.org's own domain.

`description` (top-level, required) accepts the same bare-relative-
`.md`-filename convention as before, for anything longer than a
paragraph or two:

```yaml
description: description.md   # a file in this manifest's own directory
```

### Directives: asking for the processing you want

A manifest doesn't just describe a dataset, it also states what should
be *done* with it. These are the fields that drive real processing
operations, all of them declarative -- you never invoke a pipeline, you
state an intent and the ingest side decides how to satisfy it:

| Directive | Drives |
| --- | --- |
| `pointcloud_org.federate` | whether the bytes are copied into this archive or only linked |
| `pointcloud_org.derivatives` | whether DTM/DSM/ambient-occlusion rasters are requested (see the caveat below) |
| `pointcloud_org.derivative_processing` | how they'd be built -- resolution, PDAL filter stages, WhiteboxTools parameters |
| `derivative_processing.resolution` | also bounds the elevation-statistics read behind the hero image and the viewer's default colour range |
| `pointcloud_org.viewer.default_asset_id` | which asset the dataset page's viewer opens on, and which one the hero image is captured from |
| `copc_resolution` (per item or `items_dir`) | the resolution each asset's metadata is read at |
| `items_dir.pattern` | which files under a prefix become items |

**Caveat on derivatives, so nobody plans around a promise:** the
`derivatives`/`derivative_processing` directives are validated, carried
through the pipeline, and enqueued -- but the stage that would actually
produce the DTM/DSM/ambient-occlusion rasters is still a stub, so no
raster output exists yet. Setting them today records the intent
correctly and costs nothing; it just doesn't yet produce a file.

#### Overriding derivative generation

Only consulted when `pointcloud_org.derivatives: true`. Every field is
optional; omit anything to use the engine's default.

```yaml
pointcloud_org:
  derivative_processing:
    resolution: 1.0   # GSD in meters, overrides each item's copc_resolution for derivatives only, AND bounds the elevation-stats read used for the hero image/viewer's default color range (see below)
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

- [`hk-2020/`](hk-2020/) -- `items_dir` (many same-CRS files under one
  prefix), multiple `providers` (producer + separate host), and a
  `pdal_filters_file`.
- [`wi-adams-2019/manifest.yaml`](wi-adams-2019/manifest.yaml) -- a
  hand-authored `items` list with many individually-titled tiles.
- [`barringer-meteorite-crater/manifest.yaml`](barringer-meteorite-crater/manifest.yaml) --
  a minimal single-item manifest with a `links`/`sci:citation`/`sci:doi` entry.

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

## Asking for work: labels and commands

### What the automation posts, and when

Every one of these is a *sticky* comment: it is edited in place on repeat
rather than added again, so a PR with six pushes still has one of each.

| Comment | When | What to do about it |
| --- | --- | --- |
| Preflight result | Every push to an open PR, once schema validation passes | Read it. This is the real check against storage — green here means merging will work |
| Ingest result | On merge; then updated when assembly finishes | Nothing. It ends with point count, size, license and a link to the live page |
| Too many datasets | A PR touching more than one dataset directory | Split it into separate PRs. The check also fails red |
| Removal notice | A PR deleting a dataset directory | Confirm it says what you meant. Merging de-indexes the dataset; the stored data itself is untouched |
| Federate notice | A manifest setting `pointcloud_org.federate: true` | Check the estimated size — merging copies that much data into pointcloud.org's own storage |
| Upstream drift | The weekly sweep, when a dataset's source URLs stop resolving | Fix the manifest, or say so on the PR. It tags the `github_owner` and is edited week to week rather than restacked |

Alongside the preflight comment you also get one `pointcloud/*` commit status
per check (`pointcloud/file-existence`, `pointcloud/crs-consistency`,
`pointcloud/pdal-filters`), so a red X names which check failed without you
opening anything.


Everything above is driven by the *content* of your manifest. Two other
mechanisms let you drive the pipeline without changing any content: a
label on a PR, or a comment addressed to the bot.

### Labels

| Label | Who applies it | What it means |
| --- | --- | --- |
| `removal` | automation | This PR deletes a dataset directory. Applied together with a comment spelling out what merging it will do. |
| `federated` | automation | This PR's manifest sets `pointcloud_org.federate: true`, so merging it copies data into pointcloud.org's storage. The accompanying comment estimates how much. |
| `reingest` | **you**, on an already-merged PR | Re-run the whole ingest for that dataset. See below. |

The first two are signals *from* the automation, applied so a reviewer
can see at a glance what a PR commits the archive to. `reingest` is the
one you apply yourself; it's an instruction.

### Reingesting a dataset

To re-run ingest for a dataset that's already live -- to pick up an
infrastructure-side fix, with no manifest content change needed --
apply the `reingest` label to any merged PR that touched
`manifests/<dataset-id>/`, or comment
`@pointcloud-org, please reingest <dataset-id>` anywhere.

Either way the bot opens a new, small PR that re-touches that dataset's
`manifest.yaml` (an appended comment line; nothing else changes) and
comments back where the request came from. **It does not merge that PR
-- an admin does.** Nothing is re-ingested until it lands, and the
ordinary checks on it are the gate, exactly as for a first-time
contribution. The label removes itself afterwards so it can be applied
again later.

### Commands

Comment on any issue or pull request:

```
@pointcloud-org, please reingest chicago-downtown
@pointcloud-org, please refresh-stac
@pointcloud-org, please check-reachability
```

- **`reingest <dataset-id>`** -- as above. The id is a directory name
  under `manifests/`; for a grouped dataset use just the leaf.
- **`refresh-stac`** -- rebuilds the archive-wide STAC artifacts (the
  root `catalog.json`, `collections.json`, and the single-file
  `items.parquet`). Useful after a manual fix; normally these maintain
  themselves on every ingest and on a six-hourly schedule.
- **`check-reachability`** -- sweeps the whole archive and reports a
  table of only what's broken, grouped by the responsible
  `github_owner`. It checks every dataset, but not every URL: each
  dataset's single points of failure (an `ept_source`, `stac_item` or
  `external_source`) are always fetched, and its listed assets are
  sampled -- up to 25 per dataset, spread across the list -- because at
  archive scale the alternative is hundreds of thousands of requests to
  other people's servers. The report says how many it sampled. This also
  runs on its own every Monday, filing or updating a single
  `upstream-drift` tracking issue.

  A URL is only believed broken after it fails a retry: network errors,
  timeouts, 429s and 5xx get up to three attempts, while a 404 is taken at
  its word. Reports say how many attempts a failure took, so a persistent
  breakage reads differently from a blip.

  Alongside the tracking issue, each broken dataset gets a comment on the
  pull request that last touched it, tagging that manifest's
  `github_owner`. The sweep finds that pull request from
  `pointcloud_org:ingest` on the dataset's published STAC Collection —
  recorded at ingest, since that is the only point that knows for certain
  which PR produced the current state — and falls back to the manifest
  directory's own commit history for datasets ingested before that field
  existed. An open pull request touching the dataset wins over the
  original one, on the grounds that a fix in progress is where the
  conversation already is. Comments are capped per sweep and edited in
  place week to week, rather than stacking up.

Note that the per-PR reachability check is exhaustive, unlike the sweep:
when you open a pull request, every foreign URL your manifest names is
fetched.

Anyone can ask, but these commands change published data, so they only
run for accounts with write access; anyone else gets a comment saying
so, and nothing else happens. Past that check, an unrecognised command
gets a help reply listing the three.

## License

Manifests describe third-party datasets; each dataset's `license` field
states the terms of the underlying data, which may differ from this
repo's own license.
