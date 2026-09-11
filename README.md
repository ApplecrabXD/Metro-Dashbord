# __THIS IS AI SLOP__

yea no hiding this is fully made by claude and amazon quick as a proof of concept for a home assistant dashboard 

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

