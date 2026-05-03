"use strict";

/**
 * Life360 Tracker - Person HTML map generator
 * Generates the single-person Leaflet HTML map with day/range picker
 */
class TrackerPersonHtml {
	/**
	 * @param {object} config - Tracker config (mapColors, pollInterval)
	 */
	constructor(config) {
		this.config = config;
	}

	/**
	 * Generates the HTML content of the single-person map with day dropdown
	 *
	 * @param {{name:string, color:string, id?:string}} person
	 * @param {object} fc - FeatureCollection (allTime)
	 * @param {boolean} includeRoute
	 * @returns {string} Complete HTML string of the Leaflet single-person map
	 */
	generate(person, fc, includeRoute = true) {
		const c = this.config.mapColors;
		console.warn(`[Tracker] legendEnabled = ${c.legendEnabled}, mapColors = ${JSON.stringify(c)}`);
		const color = person.color || "#4a90e2";
		const dark = this._darkenColor(color, 0.6);
		const firstName = person.name.split(" ")[0];
		const refresh = this.config.pollInterval + 10;
		const features = (fc.features || []).filter(f => f.geometry?.coordinates?.length > 0);

		if (features.length === 0) {
			return this._emptyHTML(person.name, c);
		}

		const today = new Date().toISOString().slice(0, 10);
		const dates = features.map(f => f.properties.date);
		const selDate = dates.includes(today) ? today : dates[dates.length - 1];

		const featuresJSON = JSON.stringify(
			features.map(f => {
				if (includeRoute) {
					return {
						date: f.properties.date,
						coords: f.geometry.coordinates.map(coord => [coord[1], coord[0]]),
						timestamps: f.geometry.coordinates.map(coord => coord[2] || null),
						color: f.properties.color || color,
					};
				}
				const lastCoord = f.geometry.coordinates[f.geometry.coordinates.length - 1];
				return {
					date: f.properties.date,
					coords: lastCoord ? [[lastCoord[1], lastCoord[0]]] : [],
					timestamps: lastCoord ? [lastCoord[2] || null] : [],
					color: f.properties.color || color,
				};
			}),
		);

		const personKey = person.id ? String(person.id) : person.name.replace(/[^a-zA-Z0-9]/g, "_");
		const headerFg = this._getContrastText(c.headerBg);
		const controlBg = this._scaleColor(c.headerBg, 0.82);
		const controlBorder = this._scaleColor(c.headerBg, 0.62);

		return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="${refresh}">
<title>${firstName} – Tracker</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:sans-serif; background:${c.pageBg}; color:#eee; display:flex; flex-direction:column; height:100vh; color-scheme:${headerFg === "#111111" ? "light" : "dark"}; }
  #header { padding:8px 14px; background:${c.headerBg}; display:flex; align-items:center; justify-content:space-between; font-size:13px; border-bottom:2px solid ${c.headerBorder}; flex-wrap:wrap; gap:6px; min-height:44px; }
  #header h2 { font-size:15px; color:${headerFg}; margin:0; white-space:nowrap; }
  #header-right { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-left:auto; }
  #headerInfo { color:${headerFg}; }
  .range-label { color:${headerFg}; font-size:12px; white-space:nowrap; }
  input[type=date] {
    background:${controlBg};
    color:${headerFg};
    border:1px solid ${controlBorder};
    border-radius:4px;
    padding:3px 6px;
    font-size:13px;
    cursor:pointer;
    color-scheme:${headerFg === "#111111" ? "light" : "dark"};
  }
  .route-checkbox-label { display:inline-flex; align-items:center; gap:4px; margin-left:12px; user-select:none; color:${headerFg}; }
  .route-checkbox-label input[type="checkbox"] { vertical-align:middle; accent-color:${color}; margin:0; }
  #map { flex:1; min-height:0; }
  #footer { padding:5px 14px; background:${c.headerBg}; display:flex; align-items:center; gap:20px; font-size:12px; border-top:1px solid ${c.headerBorder}; flex-wrap:wrap; min-height:30px; }
  .leg-entry { display:inline-flex; align-items:center; gap:6px; color:${headerFg}; white-space:nowrap; }
  .leg-svg { display:inline-block; flex-shrink:0; }
</style>
</head>
<body>
<div id="header">
  <h2>📍 ${firstName}</h2>
  <div id="header-right">
    <span id="headerInfo"></span>
    <span class="range-label" id="labelFrom">From</span>
    <input type="date" id="dateFrom">
    <span class="range-label" id="labelTo">To</span>
    <input type="date" id="dateTo">
    <label class="route-checkbox-label">
      <input type="checkbox" id="showRoute"> Route
    </label>
  </div>
</div>
<div id="map"></div>
${
	c.legendEnabled
		? `<div id="footer">
  <span class="leg-entry">
    <svg class="leg-svg" width="16" height="16" viewBox="0 0 16 16">
      <circle cx="8" cy="8" r="6" fill="${dark}" stroke="#fff" stroke-width="1.5"/>
    </svg>
    Startpunkt
  </span>
  <span class="leg-entry">
    <svg class="leg-svg" width="16" height="16" viewBox="0 0 16 16">
      <circle cx="8" cy="8" r="5" fill="${color}" stroke="#fff" stroke-width="1.5" fill-opacity="0.6"/>
    </svg>
    Zwischenpunkt
  </span>
  <span class="leg-entry">
    <svg class="leg-svg" width="14" height="18" viewBox="0 0 14 18">
      <path fill-rule="evenodd" d="M7 0C3.13 0 0 3.13 0 7c0 5.25 7 11 7 11s7-5.75 7-11c0-3.87-3.13-7-7-7z M4 7a3 3 0 1 0 6 0 3 3 0 0 0-6 0z" fill="${color}" stroke="#fff" stroke-width="0.8"/>
    </svg>
    Aktuelle Position
  </span>
</div>`
		: ``
}
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
  const FEATURES       = ${featuresJSON};
  const COLOR          = "${color}";
  const DARK           = "${dark}";
  const SEL_DATE       = "${selDate}";
  const MARKER_OPACITY = ${c.markerOpacity};
  const MARKER_SIZE    = ${c.markerSize};
  const STORAGE_KEY    = "tracker_showRoute_${personKey}";

  const map = L.map('map');
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap', maxZoom: 19
  }).addTo(map);

  let layers = [];
  function clearLayers() { layers.forEach(l => map.removeLayer(l)); layers = []; }

  function fmt(ts) {
    if (!ts) return '–';
    return new Date(ts).toLocaleTimeString('de-DE', { hour:'2-digit', minute:'2-digit' });
  }

  function pinIcon(color) {
    const w = Math.round(28 * MARKER_SIZE);
    const h = Math.round(36 * MARKER_SIZE);
    return L.divIcon({
      className: '',
      html: '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 28 36" style="opacity:' + MARKER_OPACITY + '"><path fill-rule="evenodd" d="M14 0C6.27 0 0 6.27 0 14c0 9.33 14 22 14 22S28 23.33 28 14C28 6.27 21.73 0 14 0z M8 14a6 6 0 1 0 12 0a6 6 0 1 0-12 0z" fill="' + color + '" stroke="#fff" stroke-width="1.5"/></svg>',
      iconSize: [w, h],
      iconAnchor: [Math.round(w / 2), h],
      popupAnchor: [0, -h]
    });
  }

  function showDay(date) {
    clearLayers();
    const feat = FEATURES.find(f => f.date === date);
    if (!feat || feat.coords.length === 0) return;
    const c = feat.color || COLOR;
    const ts = feat.timestamps;
    const coords = feat.coords;
    const showRoute = document.getElementById('showRoute')?.checked;
    if (showRoute) {
      const line = L.polyline(coords, { color:c, weight:${c.routeWeight}, opacity:${c.routeOpacity} }).addTo(map);
      layers.push(line);
    }
    if (showRoute && coords.length > 1) {
      layers.push(
        L.circleMarker(coords[0], { radius:8, fillColor:DARK, color:'#fff', weight:2, fillOpacity:1 })
          .bindPopup('▶ Start: ' + fmt(ts[0])).addTo(map)
      );
    }
    layers.push(
      L.marker(coords[coords.length-1], { icon: pinIcon(c) })
        .bindPopup('📍 Last: ' + fmt(ts[ts.length-1])).addTo(map)
    );
    if (showRoute) {
      coords.forEach(function(coord, i) {
        if (i === 0 || i === coords.length - 1) return;
        layers.push(
          L.circleMarker(coord, { radius:4, fillColor:c, color:'#fff', weight:1, fillOpacity:0.6 })
            .bindPopup(fmt(ts[i])).addTo(map)
        );
      });
    }
    if (showRoute && coords.length > 1) {
      map.fitBounds(L.latLngBounds(coords), { padding:[30,30] });
    } else {
      map.setView(coords[coords.length-1], 16);
    }
    document.getElementById('headerInfo').textContent =
      (showRoute && coords.length > 1
        ? 'Last point: ' + fmt(ts[ts.length-1])
        : 'Last point (' + fmt(ts[ts.length-1]) + ')');
  }

  const sortedDates = [...new Set(FEATURES.map(f => f.date))].sort();
  const inpFrom = document.getElementById('dateFrom');
  const inpTo   = document.getElementById('dateTo');
  inpFrom.min = inpTo.min = sortedDates[0];
  inpFrom.max = inpTo.max = "${today}";

  let initFrom = "${selDate}", initTo = "${today}";
  if (location.hash) {
    const parts = location.hash.slice(1).split('_');
    if (parts.length === 2) { initFrom = parts[0]; initTo = parts[1]; }
  }
  inpFrom.value = initFrom;
  inpTo.value   = initTo;

  function showRange(from, to) {
    clearLayers();
    const feats = FEATURES.filter(f => f.date >= from && f.date <= to && f.coords.length > 0);
    if (feats.length === 0) return;
    const maxDate = feats.reduce((max, f) => f.date > max ? f.date : max, '');
    const bounds = [];
    feats.forEach(function(feat) {
      const fc     = feat.color || COLOR;
      const ts     = feat.timestamps;
      const coords = feat.coords;
      const line = L.polyline(coords, { color:fc, weight:${c.routeWeight}, opacity:${c.routeOpacity} }).addTo(map);
      layers.push(line);
      bounds.push(...coords);
      layers.push(
        L.circleMarker(coords[0], { radius:7, fillColor:DARK, color:'#fff', weight:2, fillOpacity:1 })
          .bindPopup(feat.date + '<br>▶ ' + fmt(ts[0])).addTo(map)
      );
      if (feat.date === maxDate) {
        layers.push(
          L.marker(coords[coords.length-1], { icon: pinIcon(fc) })
            .bindPopup(feat.date + '<br>📍 ' + fmt(ts[ts.length-1])).addTo(map)
        );
      } else {
        layers.push(
          L.circleMarker(coords[coords.length-1], { radius:8, fillColor:fc, color:'#fff', weight:2, fillOpacity:MARKER_OPACITY })
            .bindPopup(feat.date + '<br>📍 ' + fmt(ts[ts.length-1])).addTo(map)
        );
      }
      coords.forEach(function(coord, i) {
        if (i === 0 || i === coords.length - 1) return;
        layers.push(
          L.circleMarker(coord, { radius:4, fillColor:fc, color:'#fff', weight:1, fillOpacity:0.6 })
            .bindPopup(feat.date + '<br>' + fmt(ts[i])).addTo(map)
        );
      });
    });
    if (bounds.length > 0) map.fitBounds(L.latLngBounds(bounds), { padding:[30,30] });
    location.hash = from + '_' + to;
  }

  inpFrom.addEventListener('change', function() { if (inpFrom.value <= inpTo.value) showRange(inpFrom.value, inpTo.value); });
  inpTo.addEventListener('change',   function() { if (inpFrom.value <= inpTo.value) showRange(inpFrom.value, inpTo.value); });

  const showRouteCheckbox = document.getElementById('showRoute');
  let showRouteState = localStorage.getItem(STORAGE_KEY);
  if (showRouteState === null) showRouteState = 'true';
  showRouteCheckbox.checked = showRouteState === 'true';

  if (!showRouteCheckbox.checked) {
    document.getElementById('dateFrom').style.display = 'none';
    document.getElementById('dateTo').style.display = 'none';
    document.getElementById('labelFrom').style.display = 'none';
    document.getElementById('labelTo').style.display = 'none';
    showDay(inpTo.value);
  } else {
    showRange(initFrom, initTo);
  }

  showRouteCheckbox.addEventListener('change', function() {
    localStorage.setItem(STORAGE_KEY, this.checked ? 'true' : 'false');
    var show = this.checked;
    document.getElementById('dateFrom').style.display = show ? '' : 'none';
    document.getElementById('dateTo').style.display = show ? '' : 'none';
    document.getElementById('labelFrom').style.display = show ? '' : 'none';
    document.getElementById('labelTo').style.display = show ? '' : 'none';
    if (show) { showRange(inpFrom.value, inpTo.value); } else { showDay(inpTo.value); }
  });

  setTimeout(function() {
    const url = new URL(window.location.href);
    url.searchParams.set('_t', Date.now());
    window.location.replace(url.toString());
  }, ${refresh} * 1000);
</script>
</body>
</html>`;
	}

	/**
	 * Returns an empty HTML page when no movement data is available
	 *
	 * @param {string} name - Display name shown in the page header
	 * @param {{pageBg:string}} c - Map color configuration
	 * @returns {string} Complete HTML page with an empty-state message
	 */
	_emptyHTML(name, c) {
		return `<!DOCTYPE html><html><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:${c.pageBg};color:#fff"><div style="text-align:center"><h2>📍 ${name}</h2><p>No movement recorded yet.</p></div></body></html>`;
	}

	/**
	 * Returns black or white depending on background brightness
	 *
	 * @param {string} hex
	 * @returns {string} High-contrast text color for the given background
	 */
	_getContrastText(hex) {
		const r = parseInt(hex.slice(1, 3), 16);
		const g = parseInt(hex.slice(3, 5), 16);
		const b = parseInt(hex.slice(5, 7), 16);
		return (r * 299 + g * 587 + b * 114) / 1000 >= 160 ? "#111111" : "#f5f5f5";
	}

	/**
	 * Lightens or darkens a hex color by multiplying RGB channels
	 *
	 * @param {string} hex
	 * @param {number} factor
	 * @returns {string} Adjusted hex color based on the given factor
	 */
	_scaleColor(hex, factor = 1) {
		const r = parseInt(hex.slice(1, 3), 16);
		const g = parseInt(hex.slice(3, 5), 16);
		const b = parseInt(hex.slice(5, 7), 16);
		return `#${[r, g, b]
			.map(v =>
				Math.max(0, Math.min(255, Math.round(v * factor)))
					.toString(16)
					.padStart(2, "0"),
			)
			.join("")}`;
	}

	/**
	 * Calculates a darker variant of a hex color
	 *
	 * @param {string} hex - Hex color value e.g. #4a90e2
	 * @param {number} factor - Darkening factor (0-1)
	 * @returns {string} Darkened hex color
	 */
	_darkenColor(hex, factor = 0.6) {
		const r = parseInt(hex.slice(1, 3), 16);
		const g = parseInt(hex.slice(3, 5), 16);
		const b = parseInt(hex.slice(5, 7), 16);
		return `#${[r, g, b]
			.map(v =>
				Math.round(v * factor)
					.toString(16)
					.padStart(2, "0"),
			)
			.join("")}`;
	}
}

module.exports = TrackerPersonHtml;
