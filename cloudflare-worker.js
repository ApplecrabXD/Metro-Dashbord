/* Cloudflare Worker: same job as server.py, but running in the cloud so
 * GitHub Pages (or any static host) can reach the Adelaide Metro live feed
 * reliably, without depending on free public CORS proxies.
 *
 * Deploy steps: see the "Hosting on GitHub Pages" section in README.md.
 */

const SIRI_ENDPOINT = "https://realtime.adelaidemetro.com.au/sirism/SiriStopMonitoring.svc/json/SM";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/api/siri") {
      return new Response("Not found", { status: 404 });
    }

    const target = SIRI_ENDPOINT + url.search;
    try {
      const upstream = await fetch(target, {
        headers: { "User-Agent": "Mozilla/5.0 departure-board-worker" }
      });
      const body = await upstream.text();
      return new Response(body, {
        status: upstream.status,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*"
        }
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e) }), {
        status: 502,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }
  }
};
