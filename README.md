# Adelaide Metro Departure Board

A live departure board for Adelaide Metro stops, using the public SIRI Stop Monitoring feed.

## Files

- `index.html` — the page
- `css/style.css` — styling
- `js/app.js` — all the logic (fetching, parsing the SIRI feed, rendering, stop search)
- `server.py` / `start.bat` — optional local proxy, see below

## Running it locally (most reliable)

The live feed doesn't allow direct browser access (no CORS headers), so the most reliable way to run this is through the included local proxy:

1. Install [Python 3](https://www.python.org/downloads/) if you don't have it.
2. Double-click `start.bat`. It starts a local server and opens the board in your browser.

Everything — live departures, auto-refresh, stop search — works through this local proxy with no dependency on third-party services.

## Hosting on GitHub Pages

GitHub Pages only serves static files, so `server.py` doesn't run there. The page still works, but falls back to public CORS proxies to reach the live feed, which are free but occasionally unavailable — if departures fail to load, the on-page error message explains what to try (the "Proxy" button cycles through direct/proxy modes).

To publish:

1. Create a new GitHub repository and push this folder to it (`index.html` must be at the repository root, or in a `/docs` folder).
2. In the repo, go to **Settings → Pages**.
3. Under **Source**, choose the branch (usually `main`) and folder (`/root` or `/docs`).
4. Save. GitHub gives you a URL like `https://<username>.github.io/<repo>/` within a minute or two.

### Making GitHub Pages fully reliable (optional Cloudflare Worker)

Public CORS proxies are good enough most of the time, but if you want the same reliability as running locally, deploy `cloudflare-worker.js` — a small proxy that runs in Cloudflare's free tier and does the same job as `server.py`, just in the cloud instead of on one PC. No credit card required.

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com/) and sign up for a free account.
2. In the sidebar, go to **Workers & Pages → Create → Create Worker**.
3. Give it any name (e.g. `adelaide-departure-proxy`) and click **Deploy** to create it with the default template.
4. Click **Edit code**, delete the default code, and paste in the full contents of `cloudflare-worker.js` from this folder.
5. Click **Deploy** again to publish your changes.
6. Copy the worker's URL shown in the dashboard — it looks like `https://adelaide-departure-proxy.<your-subdomain>.workers.dev`.
7. Open `js/app.js`, find the line near the top that says `var CLOUD_PROXY_ENDPOINT = "";`, and set it to your worker's URL with `/api/siri` on the end, e.g.:
   ```js
   var CLOUD_PROXY_ENDPOINT = "https://adelaide-departure-proxy.<your-subdomain>.workers.dev/api/siri";
   ```
8. Commit and push the change — GitHub Pages will pick it up automatically.

Once set, the page tries your worker before falling back to public proxies, so live data loads reliably no matter who's viewing the page.

## Stop search

Click **Load stop list** to download Adelaide Metro's stop names (from a CORS-enabled GitHub mirror of the official GTFS data), so you can search by name instead of typing a numeric stop ID. This works the same whether run locally or on GitHub Pages.
