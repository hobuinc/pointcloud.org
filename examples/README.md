# examples/

Runnable examples against the live archive. No credentials, no signup.

- **[`pystac-client-quickstart.ipynb`](pystac-client-quickstart.ipynb)** — searching
  the archive with [`pystac-client`](https://pystac-client.readthedocs.io/), the
  reference Python STAC client: opening the API, listing collections, filtering by
  bounding box, by time and by point count with CQL2, then reading actual points out
  of a COPC file over HTTPS with [`laspy`](https://laspy.readthedocs.io/) — filtered
  by resolution and by bounds, and plotted — and finally running the same queries in
  bulk against the archive's single STAC-GeoParquet file with DuckDB.

## Run it in your browser

**<https://pointcloud.org/lite/lab/index.html?path=pystac-client-quickstart.ipynb>**

That is this same file, served through [JupyterLite](https://jupyterlite.readthedocs.io/):
the Python runs in your tab, so there is nothing to install and no server to trust.
Everything it queries is the live archive.

The notebook is written to run either way. It detects the browser with
`sys.platform == "emscripten"` and adapts in two places: it routes HTTP through the
browser with [`pyodide-http`](https://github.com/koenvo/pyodide-http), and it hands
`CopcReader` a small serial range-request object, because laspy's own HTTP source
fetches octree nodes across a thread pool and there are no threads in the browser.
Everywhere else the code is identical.

## About the committed outputs

The notebook is committed **with its outputs**, executed against
`https://pointcloud.org/stac`. That is deliberate: it means the file doubles as a
record of what the API actually returned, so a reader can tell the difference between
"this is how it works" and "this is how it was supposed to work". Re-running it is the
quickest way to see whether anything has drifted.

Point counts and dataset counts in the committed outputs are a snapshot and will grow
as datasets are contributed.
