# examples/

Runnable examples against the live archive. No credentials, no signup.

- **[`pystac-client-quickstart.ipynb`](pystac-client-quickstart.ipynb)** — searching
  the archive with [`pystac-client`](https://pystac-client.readthedocs.io/), the
  reference Python STAC client: opening the API, listing collections, filtering by
  bounding box, by time and by point count with CQL2, then reading actual points out
  of a COPC file over HTTPS with [`laspy`](https://laspy.readthedocs.io/) — filtered
  by resolution and by bounds, and plotted — and finally running the same queries in
  bulk against the archive's single STAC-GeoParquet file with DuckDB.

The notebook is committed **with its outputs**, executed against
`https://pointcloud.org/stac`. That is deliberate: it means the file doubles as a
record of what the API actually returned, so a reader can tell the difference between
"this is how it works" and "this is how it was supposed to work". Re-running it is the
quickest way to see whether anything has drifted.

Point counts and dataset counts in the committed outputs are a snapshot and will grow
as datasets are contributed.
