#!/usr/bin/env python3
"""
Local server for the Adelaide Metro departure board.

Why this exists: the browser can't fetch realtime.adelaidemetro.com.au
directly because that server doesn't send CORS headers, and public
"CORS proxy" services (corsproxy.io, allorigins, etc.) are unreliable.
This tiny server serves the HTML page AND fetches the live feed itself
(no CORS restrictions apply server-to-server), so the page just calls
back to itself at /api/siri.

Usage: double-click start.bat, or run `python server.py`, then open
http://localhost:8765/
"""
import json
import urllib.request
import urllib.error
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

PORT = 8765
SIRI_ENDPOINT = "https://realtime.adelaidemetro.com.au/sirism/SiriStopMonitoring.svc/json/SM"
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) departure-board-local-proxy"


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        parts = urlsplit(self.path)
        if parts.path == "/api/siri":
            self.proxy_siri(parts.query)
        else:
            super().do_GET()

    def proxy_siri(self, query):
        url = SIRI_ENDPOINT + ("?" + query if query else "")
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=15) as resp:
                body = resp.read()
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            payload = json.dumps({"error": str(e)}).encode("utf-8")
            self.send_response(502)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    def log_message(self, fmt, *args):
        pass  # keep the console quiet


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    url = f"http://localhost:{PORT}/"
    print(f"Departure board running at {url}")
    print("Leave this window open. Close it to stop the server.")
    try:
        webbrowser.open(url)
    except Exception:
        pass
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
