/* Adelaide Metro live departure board
 *
 * Data source: Adelaide Metro's public SIRI Stop Monitoring feed. No API key
 * is required, but the feed does not send CORS headers, so a browser can't
 * read it directly from a page hosted on a different origin. To work around
 * that:
 *   1. If this page is served by server.py (local use), requests go through
 *      LOCAL_PROXY_ENDPOINT, a same-origin proxy with no CORS restriction.
 *   2. Otherwise (e.g. hosted on GitHub Pages) it falls back to a direct
 *      fetch, then to a list of public CORS proxies. Public proxies are
 *      free but not fully reliable, so several are tried in order.
 */

var SIRI_ENDPOINT = "https://realtime.adelaidemetro.com.au/sirism/SiriStopMonitoring.svc/json/SM";
var LOCAL_PROXY_ENDPOINT = "/api/siri";

// Optional: your own Cloudflare Worker proxy (see cloudflare-worker.js and
// README.md). Set this after deploying if you're hosting on GitHub Pages
// and want reliable live data without depending on public CORS proxies.
// Example: "https://adelaide-departure-proxy.YOUR-SUBDOMAIN.workers.dev/api/siri"
var CLOUD_PROXY_ENDPOINT = "https://adelaide-departure-proxy.applecrab-dev.workers.dev/api/siri";

// Nightly community mirror of Adelaide Metro's GTFS stops.txt, served with
// CORS enabled. (The official gtfs.adelaidemetro.com.au host only serves
// GTFS-Realtime data, not this file, and adelaidemetro.com.au blocks
// non-browser downloads of the static GTFS zip.)
var STOPS_URLS = [
  "https://raw.githubusercontent.com/gtfsdata/adelaidemetro-gtfs/master/gtfs/stops.txt"
];

// Public CORS proxies, tried in order as a fallback when not running
// through server.py. None of these are guaranteed to be up at any given
// moment, hence the list.
var CORS_PROXIES = [
  function (u) { return "https://api.allorigins.win/raw?url=" + encodeURIComponent(u); },
  function (u) { return "https://api.codetabs.com/v1/proxy?quest=" + encodeURIComponent(u); },
  function (u) { return "https://cors.eu.org/" + u; },
  function (u) { return "https://test.cors.workers.dev/?" + u; }
];

var proxyMode = "auto"; // auto | direct | proxy
var refreshTimer = null;
var currentStop = "16584";
var currentLabel = "Stop 16584";
var stops = [];
var activeResultIndex = -1;
var liveUpdatesStarted = false;

function byId(id) {
  return document.getElementById(id);
}

function setStatus(text, kind) {
  byId("statusText").textContent = text;
  byId("dot").className = "dot" + (kind === "live" ? " live" : kind === "err" ? " err" : "");
}

function storageGet(key) {
  try { return localStorage.getItem(key); } catch (e) { return null; }
}

function storageSet(key, value) {
  try { localStorage.setItem(key, value); } catch (e) { /* storage unavailable, ignore */ }
}

/* ---------- fetch with CORS/proxy fallback (used for stop-list downloads and as a last resort for the live feed) ---------- */

function fetchText(url) {
  if (proxyMode === "proxy") return fetchTextViaProxy(url);
  if (proxyMode === "direct") {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.text();
    });
  }
  return fetch(url).then(function (r) {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.text();
  }).catch(function () { return fetchTextViaProxy(url); });
}

function fetchTextViaProxy(url) {
  var index = 0;
  function tryNext() {
    if (index >= CORS_PROXIES.length) return Promise.reject(new Error("all proxies failed"));
    var proxied = CORS_PROXIES[index++](url);
    return fetch(proxied).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.text();
    }).catch(tryNext);
  }
  return tryNext();
}

function fetchJSON(url) {
  return fetchText(url).then(function (t) { return JSON.parse(t); });
}

/* ---------- live feed ---------- */

function buildLiveQuery() {
  return "MonitoringRef=" + encodeURIComponent(currentStop) +
    "&PreviewInterval=" + byId("preview").value +
    "&MaximumStopVisits=" + byId("maxVisits").value;
}

function buildDirectUrl() {
  return SIRI_ENDPOINT + "?" + buildLiveQuery();
}

function fetchLiveData() {
  // Tries, in order: same-origin local proxy (server.py) -> your own Cloudflare
  // Worker, if configured -> direct fetch -> public CORS proxies. The first
  // two only succeed if actually set up/running; everything else is automatic.
  var query = buildLiveQuery();
  var endpoints = [LOCAL_PROXY_ENDPOINT + "?" + query];
  if (CLOUD_PROXY_ENDPOINT) endpoints.push(CLOUD_PROXY_ENDPOINT + "?" + query);

  function tryEndpoint(i) {
    if (i >= endpoints.length) return fetchJSON(buildDirectUrl());
    return fetch(endpoints[i]).then(function (r) {
      if (!r.ok) throw new Error("proxy HTTP " + r.status);
      return r.json();
    }).catch(function () { return tryEndpoint(i + 1); });
  }
  return tryEndpoint(0);
}

/* ---------- SIRI parsing ---------- */

function parseMsDate(s) {
  if (!s || typeof s !== "string") return null;
  var m = s.replace(/\\/g, "").match(/\/Date\((\d+)/);
  if (!m) return null;
  var ms = parseInt(m[1], 10);
  return ms === 0 ? null : new Date(ms);
}

function siriValue(x) {
  if (!x) return "";
  if (x.Value != null) return x.Value;
  if (Array.isArray(x) && x[0] && x[0].Value != null) return x[0].Value;
  return "";
}

function modeOf(lineRef, operator) {
  var line = (lineRef || "").toUpperCase();
  var op = (operator || "").toLowerCase();
  if (op.indexOf("tram") >= 0 || line === "GLNELG") return "tram";
  if (op.indexOf("rail") >= 0 || op.indexOf("train") >= 0) return "train";
  if (line.indexOf("SCH") >= 0) return "schoolbus";
  return "bus";
}

function extractVisits(data) {
  var smd = data && (data.StopMonitoringDelivery ||
    (data.Siri && data.Siri.ServiceDelivery && data.Siri.ServiceDelivery.StopMonitoringDelivery));
  var first = Array.isArray(smd) ? smd[0] : smd;
  if (!first) return { responseTime: null, visits: [] };
  var visits = first.MonitoredStopVisit || [];
  return {
    responseTime: parseMsDate(first.ResponseTimestamp),
    visits: Array.isArray(visits) ? visits : [visits]
  };
}

function parseVisit(v) {
  var journey = v.MonitoredVehicleJourney || {};
  var call = journey.MonitoredCall || {};
  var aimed = parseMsDate(call.AimedArrivalTime) || parseMsDate(call.AimedDepartureTime);
  var expected = parseMsDate(call.LatestExpectedArrivalTime) ||
    parseMsDate(call.ExpectedDepartureTime) ||
    parseMsDate(call.ProvisionalExpectedDepartureTime);
  var best = expected || aimed;
  var dest = siriValue(journey.DestinationName) || siriValue(call.DestinationDisplay) ||
    siriValue(journey.DestinationRef) || "—";
  var lineRef = siriValue(journey.LineRef);
  var line = siriValue(journey.PublishedLineName) || lineRef || "?";
  var operator = siriValue(journey.OperatorRef);
  var isRealtime = !!journey.Monitored && !!expected;
  var delayMin = (expected && aimed) ? Math.round((expected - aimed) / 60000) : null;

  return {
    line: line === "GLNELG" ? "TRAM" : line,
    lineRef: lineRef,
    dest: dest,
    dir: siriValue(journey.DirectionRef),
    operator: operator.replace(/^\d+\s*-\s*/, ""),
    mode: modeOf(lineRef, operator),
    aimed: aimed,
    expected: expected,
    best: best,
    isRealtime: isRealtime,
    delay: delayMin,
    stopName: siriValue(call.StopPointName)
  };
}

/* ---------- rendering ---------- */

function render(responseTime, visits) {
  var list = byId("list");
  var parsed = [];
  for (var i = 0; i < visits.length; i++) {
    var p = parseVisit(visits[i]);
    if (p.best) parsed.push(p);
  }
  parsed.sort(function (a, b) { return a.best - b.best; });

  if (parsed.length && parsed[0].stopName) {
    if (/^Stop \d+$/.test(currentLabel)) {
      byId("stopName").textContent = parsed[0].stopName + " · " + currentStop;
    }
    var mode = parsed[0].mode;
    var modeLabel = mode === "tram" ? "Tram" : mode === "train" ? "Train" : mode === "schoolbus" ? "School bus" : "Bus";
    byId("modePill").textContent = modeLabel;
    byId("opName").textContent = parsed[0].operator || "";
  }

  if (!parsed.length) {
    var windowMinutes = byId("preview").value;
    list.innerHTML = '<div class="empty"><b>No departures in the next ' + windowMinutes + ' minutes</b> for ' + currentLabel + '.<br/>' +
      'The feed is working — this stop just has nothing scheduled/tracked right now.<br/>Try a wider window or a different stop.</div>';
    return;
  }

  var now = responseTime ? responseTime.getTime() : Date.now();
  list.innerHTML = parsed.map(function (r) {
    var mins = Math.round((r.best - now) / 60000);
    var clockTime = r.best.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    var etaText, etaClass = "";
    if (mins <= 0) {
      etaText = "Due";
      etaClass = "due";
    } else if (mins < 60) {
      etaText = mins + "′";
      etaClass = mins <= 5 ? "soon" : "";
    } else {
      etaText = clockTime;
    }

    var timeLine;
    if (r.isRealtime && r.aimed && r.expected && (r.aimed.getTime() !== r.expected.getTime())) {
      timeLine = "<s>" + r.aimed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + "</s>" + clockTime;
    } else {
      timeLine = clockTime;
    }

    var statusBadge = "";
    if (r.isRealtime) {
      if (r.delay === null || r.delay === 0) statusBadge = '<span class="badge ontime">on time</span>';
      else if (r.delay < 0) statusBadge = '<span class="badge early">' + Math.abs(r.delay) + 'm early</span>';
      else statusBadge = '<span class="badge late">' + r.delay + 'm late</span>';
    }
    var rtBadge = r.isRealtime ? '<span class="badge rt">live</span>' : '<span class="badge">scheduled</span>';
    var dirText = r.dir === "I" ? "Inbound" : r.dir === "O" ? "Outbound" : "";

    return '<div class="rowc"><div class="stripe ' + r.mode + '"></div><div class="inner">' +
      '<div class="route ' + r.mode + '">' + r.line + '</div>' +
      '<div class="mid"><div class="dest">' + r.dest + '</div>' +
      '<div class="meta">' + rtBadge + statusBadge + (dirText ? '<span class="badge">' + dirText + '</span>' : '') + '</div></div>' +
      '<div class="when"><div class="eta ' + etaClass + '">' + etaText + '</div><div class="clock">' + timeLine + '</div></div>' +
      '</div></div>';
  }).join("");
}

/* ---------- refresh cycle ---------- */

function refresh() {
  var directUrl = buildDirectUrl();
  setStatus("Fetching live departures…");
  return fetchLiveData().then(function (data) {
    var extracted = extractVisits(data);
    render(extracted.responseTime, extracted.visits);
    var stamp = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    var count = extracted.visits.length;
    setStatus(count
      ? ("Live · " + currentLabel + " · " + count + " departures · updated " + stamp)
      : ("Connected · " + currentLabel + " · no departures right now · " + stamp), "live");
  }).catch(function (e) {
    byId("list").innerHTML = '<div class="errbox"><b>Couldn\'t read the feed from this page.</b><br/>' +
      'This is almost always <b>CORS</b> (the feed works, but the browser won\'t let this page read a cross-site response directly).<br/>' +
      'Run <b>start.bat</b> (or <code>python server.py</code>) in this folder and open the page via that link — it routes requests through a local proxy with no CORS issue.<br/>' +
      'If you opened this file directly or are on GitHub Pages, the <b>Proxy</b> button below is a best-effort fallback but public proxies are sometimes down.<br/><br/>' +
      '<a href="' + directUrl + '" target="_blank" rel="noopener">Open the raw feed in a new tab</a> to confirm it returns JSON.<br/>' +
      '<small>' + (e && e.message ? e.message : e) + '</small></div>';
    setStatus("Error loading feed", "err");
  });
}

function scheduleAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  if (byId("autoRefresh").checked) {
    refreshTimer = setInterval(function () { refresh().catch(function () {}); }, 45000);
  }
}

function startLiveUpdates() {
  if (liveUpdatesStarted) return;
  liveUpdatesStarted = true;
  scheduleAutoRefresh();
}

/* ---------- stop list search ---------- */

function parseCSV(text) {
  var rows = [], i = 0, field = "", row = [], inQuotes = false;
  while (i < text.length) {
    var c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ""; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c === '\r') { /* skip */ }
      else field += c;
    }
    i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function ingestStops(text) {
  var rows = parseCSV(text.trim());
  if (!rows.length) throw new Error("empty stop list");
  var header = rows[0].map(function (h) { return h.trim(); });
  var idCol = header.indexOf("stop_id");
  var nameCol = header.indexOf("stop_name");
  var codeCol = header.indexOf("stop_code");
  if (idCol < 0 || nameCol < 0) throw new Error("missing expected columns");

  stops = [];
  for (var r = 1; r < rows.length; r++) {
    var row = rows[r];
    if (row.length <= idCol) continue;
    var id = (row[idCol] || "").trim();
    var name = (row[nameCol] || "").trim();
    var code = codeCol >= 0 ? (row[codeCol] || "").trim() : "";
    if (id && name) stops.push({ id: id, name: name, code: code });
  }
  storageSet("am_stops", JSON.stringify({ t: Date.now(), s: stops }));
  return stops.length;
}

function loadCachedStops() {
  try {
    var raw = storageGet("am_stops");
    if (!raw) return false;
    var cached = JSON.parse(raw);
    if (cached && Array.isArray(cached.s) && cached.s.length) {
      stops = cached.s;
      return true;
    }
  } catch (e) { /* corrupt cache, ignore */ }
  return false;
}

function downloadStops() {
  setStatus("Downloading stop list…");
  var index = 0;
  function tryNext() {
    if (index >= STOPS_URLS.length) {
      setStatus("Couldn't download stop list — you can still type a stop ID.", "err");
      return;
    }
    fetchText(STOPS_URLS[index++]).then(function (text) {
      if (text && text.toLowerCase().indexOf("stop_id") >= 0) {
        var count = ingestStops(text);
        setStatus("Stop list loaded (" + count.toLocaleString() + " stops). Search by name now.", "live");
        renderResults(byId("stopSearch").value);
      } else {
        tryNext();
      }
    }).catch(tryNext);
  }
  tryNext();
}

function searchStops(query) {
  query = query.trim().toLowerCase();
  if (!query) return [];
  var out = [];
  for (var i = 0; i < stops.length; i++) {
    var s = stops[i];
    if ((s.name + " " + s.code + " " + s.id).toLowerCase().indexOf(query) >= 0) {
      out.push(s);
      if (out.length >= 40) break;
    }
  }
  out.sort(function (a, b) {
    var aStarts = a.name.toLowerCase().indexOf(query) === 0 ? 0 : 1;
    var bStarts = b.name.toLowerCase().indexOf(query) === 0 ? 0 : 1;
    return aStarts - bStarts || a.name.localeCompare(b.name);
  });
  return out;
}

function renderResults(query) {
  var box = byId("results");
  var isNumeric = /^\d+$/.test(query.trim());
  if (!query.trim()) {
    box.className = "results";
    box.innerHTML = "";
    return;
  }

  var html = "";
  if (!stops.length) {
    html += '<div class="res hint">Tip: click <b>Load stop list</b> to search by name.' +
      (isNumeric ? ' Or press Enter to use ID <b>' + query.trim() + '</b>.' : '') + '</div>';
  }
  var matches = searchStops(query);
  for (var i = 0; i < matches.length; i++) {
    var s = matches[i];
    html += '<div class="res" data-id="' + s.id + '" data-name="' + s.name.replace(/"/g, '&quot;') + '">' +
      s.name + '<span class="sid">#' + s.id + (s.code && s.code !== s.id ? (" · " + s.code) : "") + '</span></div>';
  }
  if (isNumeric) {
    html = '<div class="res" data-id="' + query.trim() + '" data-name="Stop ' + query.trim() + '">Use stop ID <b>' +
      query.trim() + '</b> directly<span class="sid">manual</span></div>' + html;
  }
  if (!html) html = '<div class="res hint">No matches.</div>';

  box.innerHTML = html;
  box.className = "results open";
  activeResultIndex = -1;

  var items = box.querySelectorAll(".res[data-id]");
  for (var k = 0; k < items.length; k++) {
    (function (el) {
      el.addEventListener("click", function () {
        selectStop(el.getAttribute("data-id"), el.getAttribute("data-name"));
      });
    })(items[k]);
  }
}

function selectStop(id, name) {
  currentStop = id;
  currentLabel = name || ("Stop " + id);
  byId("stopSearch").value = (name && !/^\d+$/.test(name)) ? (name + " (#" + id + ")") : id;
  byId("stopName").textContent = currentLabel;
  byId("results").className = "results";
  addFavourite(id, currentLabel);
  startLiveUpdates();
  refresh();
}

/* ---------- favourites ---------- */

function getFavourites() {
  try { return JSON.parse(storageGet("am_favs") || "[]"); } catch (e) { return []; }
}

function addFavourite(id, label) {
  var favs = getFavourites().filter(function (x) { return x.id !== id; });
  favs.unshift({ id: id, label: label });
  favs = favs.slice(0, 6);
  storageSet("am_favs", JSON.stringify(favs));
  renderFavourites();
}

function renderFavourites() {
  var favs = getFavourites();
  byId("favs").innerHTML = favs.map(function (x) {
    return '<button data-id="' + x.id + '" data-label="' + (x.label || '').replace(/"/g, '&quot;') + '">' +
      (x.label || x.id).replace(/\s*\(#\d+\)$/, '') + '</button>';
  }).join("");

  var buttons = byId("favs").querySelectorAll("button");
  for (var i = 0; i < buttons.length; i++) {
    (function (b) {
      b.addEventListener("click", function () {
        selectStop(b.getAttribute("data-id"), b.getAttribute("data-label"));
      });
    })(buttons[i]);
  }
}

/* ---------- stop search UI events ---------- */

var searchInput = byId("stopSearch");
searchInput.addEventListener("input", function () { renderResults(searchInput.value); });
searchInput.addEventListener("focus", function () { if (searchInput.value) renderResults(searchInput.value); });
searchInput.addEventListener("keydown", function (e) {
  var items = byId("results").querySelectorAll(".res[data-id]");
  if (e.key === "ArrowDown") {
    activeResultIndex = Math.min(items.length - 1, activeResultIndex + 1);
  } else if (e.key === "ArrowUp") {
    activeResultIndex = Math.max(0, activeResultIndex - 1);
  } else if (e.key === "Enter") {
    if (items[activeResultIndex]) {
      selectStop(items[activeResultIndex].getAttribute("data-id"), items[activeResultIndex].getAttribute("data-name"));
    } else if (/^\d+$/.test(searchInput.value.trim())) {
      selectStop(searchInput.value.trim(), "Stop " + searchInput.value.trim());
    } else if (items[0]) {
      selectStop(items[0].getAttribute("data-id"), items[0].getAttribute("data-name"));
    }
    return;
  } else {
    return;
  }
  for (var i = 0; i < items.length; i++) items[i].classList.toggle("active", i === activeResultIndex);
  if (items[activeResultIndex]) items[activeResultIndex].scrollIntoView({ block: "nearest" });
  e.preventDefault();
});

document.addEventListener("click", function (e) {
  if (!e.target.closest(".searchwrap")) byId("results").className = "results";
});

/* ---------- top-level controls ---------- */

byId("loadStops").addEventListener("click", function () { startLiveUpdates(); downloadStops(); });
byId("go").addEventListener("click", function () { startLiveUpdates(); refresh().catch(function () {}); });
byId("preview").addEventListener("change", function () { startLiveUpdates(); refresh().catch(function () {}); });
byId("maxVisits").addEventListener("change", function () { startLiveUpdates(); refresh().catch(function () {}); });
byId("autoRefresh").addEventListener("change", scheduleAutoRefresh);
byId("proxyToggle").addEventListener("click", function () {
  proxyMode = proxyMode === "auto" ? "proxy" : proxyMode === "proxy" ? "direct" : "auto";
  byId("proxyToggle").textContent = "Proxy: " + (proxyMode === "auto" ? "auto" : proxyMode === "proxy" ? "on" : "off");
  startLiveUpdates();
  refresh().catch(function () {});
});

/* ---------- init (no auto-fetch at load, so the page is quiet until the user acts) ---------- */

(function init() {
  if (loadCachedStops()) {
    setStatus("Stop list ready (" + stops.length.toLocaleString() + " stops cached). Click Refresh.");
  }
  addFavourite("16584", "Beckman St (Tram) #16584");
  addFavourite("50105", "Stop 50105");
  renderFavourites();
  byId("stopName").textContent = currentLabel;
})();
