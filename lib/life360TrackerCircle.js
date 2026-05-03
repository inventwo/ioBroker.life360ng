"use strict";

/**
 * Life360 Tracker - Circle (family) HTML map generator
 * Generates the combined Leaflet HTML map for all family members
 */
class TrackerCircleHtml {
	/**
	 * @param {object} config - Tracker config (mapColors, pollInterval, familyMapHeaderName, circleId, people)
	 * @param {object} adapter - ioBroker adapter instance (for state/object reads)
	 */
	constructor(config, adapter) {
		this.config = config;
		this.adapter = adapter;
	}

	/**
	 * Generates the HTML content of the circle map with dropdown and legend
	 *
	 * @param {{person:{name:string,color:string}, fc:object}[]} personFCs
	 * @returns {Promise<string>} Complete HTML string of the Leaflet circle map
	 */
	async generate(personFCs) {
		const c = this.config.mapColors;
		const refresh = this.config.pollInterval + 10;

		const headerFg = this._getContrastText(c.headerBg);
		const controlBg = this._scaleColor(c.headerBg, 0.82);
		const controlHoverBg = this._scaleColor(c.headerBg, 0.72);
		const controlBorder = this._scaleColor(c.headerBg, 0.62);
		const subText = c.headerText || this._scaleColor(headerFg, 0.75);

		const circleName = await this._resolveCircleName(personFCs);

		const allFeatures = [];
		for (const { person, fc } of personFCs) {
			for (const f of fc.features || []) {
				if (f.geometry?.coordinates?.length > 0) {
					allFeatures.push({
						date: f.properties.date,
						name: person.name,
						color: person.color,
						coords: f.geometry.coordinates.map(coord => [coord[1], coord[0]]),
						timestamps: f.geometry.coordinates.map(coord => coord[2] || null),
					});
				}
			}
		}

		if (allFeatures.length === 0) {
			return this._emptyHTML(circleName, c);
		}

		const allDates = [...new Set(allFeatures.map(f => f.date))].sort();
		const today = new Date().toISOString().slice(0, 10);
		const selDate = allDates.includes(today) ? today : allDates[allDates.length - 1];

		const uniquePeople = [...new Map(personFCs.map(({ person }) => [person.name, person])).values()];
		const legendItems = uniquePeople
			.map(person => {
				const firstName = person.name.split(" ")[0];
				return (
					`<label class="legend-item">` +
					`<input type="checkbox" class="personToggle" value="${person.name}" checked style="accent-color:${person.color}">` +
					`<span>${firstName}</span>` +
					`</label>`
				);
			})
			.join("");

		const featuresJSON = JSON.stringify(allFeatures);

		return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="${refresh}">
<title>${circleName} – Tracker</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:sans-serif; background:${c.pageBg}; color:#eee; display:flex; flex-direction:column; height:100vh; color-scheme:${headerFg === "#111111" ? "light" : "dark"}; }
  #header { padding:8px 14px; background:${c.headerBg}; display:flex; align-items:center; justify-content:space-between; font-size:13px; border-bottom:2px solid ${c.headerBorder}; flex-wrap:wrap; gap:8px; min-height:44px; }
  #header h2 { font-size:15px; color:${headerFg}; margin:0; white-space:nowrap; }
  #header-right { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-left:auto; }
  .route-checkbox-label { display:inline-flex; align-items:center; gap:4px; margin-left:12px; user-select:none; color:${headerFg}; }
  .route-checkbox-label input[type="checkbox"] { vertical-align:middle; margin:0; }
  #legendWrap { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  #legend { color:${subText}; font-size:12px; display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  .legend-actions { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
  .legend-btn {
    background:${controlBg};
    color:${headerFg};
    border:1px solid ${controlBorder};
    border-radius:4px;
    padding:4px 8px;
    font-size:12px;
    cursor:pointer;
    transition:background 0.15s ease, border-color 0.15s ease, transform 0.05s ease;
  }
  .legend-btn:hover { background:${controlHoverBg}; }
  .legend-btn:active { transform:translateY(1px); }
  .legend-item { display:inline-flex; align-items:center; gap:6px; cursor:pointer; user-select:none; color:${headerFg}; }
  .legend-item input { margin:0; cursor:pointer; }
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
  #map { flex:1; }
  #footer { padding:5px 14px; background:${c.headerBg}; display:flex; align-items:center; gap:20px; font-size:12px; border-top:1px solid ${c.headerBorder}; flex-wrap:wrap; min-height:30px; }
  .leg-entry { display:inline-flex; align-items:center; gap:6px; color:${headerFg}; white-space:nowrap; }
  .leg-svg { display:inline-block; flex-shrink:0; }
  @media (max-width: 900px) {
    #header { align-items:stretch; }
    #header-right { width:100%; margin-left:0; }
    #legendWrap { width:100%; }
  }
</style>
</head>
<body>
<div id="header">
  <h2>👨‍👩‍👧 ${circleName}</h2>
  <div id="header-right">
    <div id="legendWrap">
      <div class="legend-actions">
        <button type="button" id="showAll" class="legend-btn">All on</button>
        <button type="button" id="hideAll" class="legend-btn">All off</button>
      </div>
      <div id="legend">${legendItems}</div>
    </div>
    <span class="range-label" id="labelFrom">From</span>
    <input type="date" id="dateFrom">
    <span class="range-label" id="labelTo">To</span>
    <input type="date" id="dateTo">
  </div>
  <label class="route-checkbox-label">
    <input type="checkbox" id="showRoute"> Route
  </label>
</div>
<div id="map"></div>
${
	c.legendEnabled
		? `<div id="footer">
  <span class="leg-entry">
    <svg class="leg-svg" width="16" height="16" viewBox="0 0 16 16">
      <circle cx="8" cy="8" r="6" fill="${headerFg}" stroke="${c.headerBg}" stroke-width="1.5" opacity="0.9"/>
    </svg>
    Startpunkt
  </span>
  <span class="leg-entry">
    <svg class="leg-svg" width="16" height="16" viewBox="0 0 16 16">
      <circle cx="8" cy="8" r="5" fill="${headerFg}" stroke="${c.headerBg}" stroke-width="1.5" opacity="0.5"/>
    </svg>
    Zwischenpunkt
  </span>
  <span class="leg-entry">
    <svg class="leg-svg" width="14" height="18" viewBox="0 0 14 18">
      <path fill-rule="evenodd" d="M7 0C3.13 0 0 3.13 0 7c0 5.25 7 11 7 11s7-5.75 7-11c0-3.87-3.13-7-7-7z M4 7a3 3 0 1 0 6 0 3 3 0 0 0-6 0z" fill="${headerFg}" stroke="${c.headerBg}" stroke-width="0.8"/>
    </svg>
    Aktuelle Position
  </span>
</div>`
		: ``
}
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
  const FEATURES       = ${featuresJSON};
  const SEL_DATE       = "${selDate}";
  const MARKER_OPACITY = ${c.markerOpacity};
  const MARKER_SIZE    = ${c.markerSize};
  const visiblePeople  = Object.fromEntries([...new Set(FEATURES.map(f => f.name))].map(name => [name, true]));
  const STORAGE_KEY    = "tracker_showRoute_circle";

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

  function darken(hex, f) {
    const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
    return '#' + [r,g,b].map(v => Math.round(v*f).toString(16).padStart(2,'0')).join('');
  }

  function getVisibleFeatures() {
    return FEATURES.filter(f => visiblePeople[f.name] && f.coords.length > 0);
  }

  function renderFeatures(feats, withDateOnly) {
    clearLayers();
    if (feats.length === 0) return;
    const showRoute = document.getElementById('showRoute')?.checked;
    const bounds = [];
    const maxDateByPerson = {};
    feats.forEach(function(f) {
      if (!maxDateByPerson[f.name] || f.date > maxDateByPerson[f.name]) maxDateByPerson[f.name] = f.date;
    });
    feats.forEach(function(feat) {
      const color = feat.color;
      const dark = darken(color, 0.6);
      const coords = feat.coords;
      const ts = feat.timestamps;
      const prefix = withDateOnly ? feat.date + '<br>' : feat.name + '<br>';
      if (showRoute) {
        const line = L.polyline(coords, { color:color, weight:${c.routeWeight}, opacity:${c.routeOpacity} }).addTo(map);
        layers.push(line);
        bounds.push(...coords);
      }
      if (showRoute && coords.length > 1) {
        layers.push(
          L.circleMarker(coords[0], { radius:7, fillColor:dark, color:'#fff', weight:2, fillOpacity:1 })
            .bindPopup(prefix + '▶ Start: ' + fmt(ts[0])).addTo(map)
        );
      }
      if (feat.date === maxDateByPerson[feat.name]) {
        layers.push(
          L.marker(coords[coords.length - 1], { icon: pinIcon(color) })
            .bindPopup(prefix + '📍 ' + fmt(ts[ts.length - 1])).addTo(map)
        );
      } else {
        layers.push(
          L.circleMarker(coords[coords.length - 1], { radius:8, fillColor:color, color:'#fff', weight:2, fillOpacity:MARKER_OPACITY })
            .bindPopup(prefix + '📍 ' + fmt(ts[ts.length - 1])).addTo(map)
        );
      }
      if (showRoute) {
        coords.forEach(function(coord, i) {
          if (i === 0 || i === coords.length - 1) return;
          layers.push(
            L.circleMarker(coord, { radius:4, fillColor:color, color:'#fff', weight:1, fillOpacity:0.6 })
              .bindPopup(prefix + fmt(ts[i])).addTo(map)
          );
        });
      }
    });
    if (showRoute && bounds.length > 0) {
      map.fitBounds(L.latLngBounds(bounds), { padding:[30,30] });
    } else if (!showRoute && feats.length > 0) {
      const lastPoints = feats.map(f => f.coords[f.coords.length - 1]);
      if (lastPoints.length === 1) { map.setView(lastPoints[0], 16); }
      else { map.fitBounds(L.latLngBounds(lastPoints), { padding:[30,30] }); }
    }
  }

  function showDay(date) {
    renderFeatures(getVisibleFeatures().filter(f => f.date === date), false);
  }

  function showRange(from, to) {
    renderFeatures(getVisibleFeatures().filter(f => f.date >= from && f.date <= to), true);
    location.hash = from + '_' + to;
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

  function refreshCurrentView() {
    if (inpFrom.value && inpTo.value && inpFrom.value <= inpTo.value) {
      showRange(inpFrom.value, inpTo.value);
    } else {
      showDay(SEL_DATE);
    }
  }

  document.querySelectorAll('.personToggle').forEach(cb => {
    cb.addEventListener('change', function() {
      visiblePeople[this.value] = this.checked;
      refreshCurrentView();
    });
  });

  document.getElementById('showAll').addEventListener('click', function() {
    document.querySelectorAll('.personToggle').forEach(cb => { cb.checked = true; visiblePeople[cb.value] = true; });
    refreshCurrentView();
  });
  document.getElementById('hideAll').addEventListener('click', function() {
    document.querySelectorAll('.personToggle').forEach(cb => { cb.checked = false; visiblePeople[cb.value] = false; });
    refreshCurrentView();
  });

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
	 * Resolves the circle display name from config or ioBroker state
	 *
	 * @param {{person:{name:string,color:string}, fc:object}[]} personFCs
	 * @returns {Promise<string>} Resolved circle name
	 */
	async _resolveCircleName(personFCs) {
		if (
			this.config.familyMapHeaderName &&
			typeof this.config.familyMapHeaderName === "string" &&
			this.config.familyMapHeaderName.trim()
		) {
			this.adapter.log.debug(
				`[Tracker] CircleMap: using user-defined header name: ${this.config.familyMapHeaderName.trim()}`,
			);
			return this.config.familyMapHeaderName.trim();
		}
		try {
			const ns = this.config.namespace;
			const firstPerson = personFCs[0]?.person;
			let circleId = firstPerson?.circleId || this.config.circleId || this.config.people?.[0]?.circleId;
			if (!circleId) {
				const circleObjects = await this.adapter.getObjectViewAsync("system", "channel", {
					startkey: `${ns}.circles.`,
					endkey: `${ns}.circles.\u9999`,
				});
				const circleRow = circleObjects?.rows?.find(
					r => r.id && r.id.split(".").length === ns.split(".").length + 2,
				);
				if (circleRow) {
					circleId = circleRow.id.split(".").pop();
					this.adapter.log.debug(`[Tracker] CircleMap: circleId from object store: ${circleId}`);
				}
			}
			this.adapter.log.debug(`[Tracker] CircleMap: detected circleId = ${circleId}`);
			if (circleId) {
				const stateId = `${ns}.circles.${circleId}.name`;
				const state = await this.adapter.getStateAsync(stateId);
				this.adapter.log.debug(`[Tracker] CircleMap: reading state ${stateId}, value: ${state?.val}`);
				if (state && typeof state.val === "string" && state.val.trim()) {
					return state.val.trim();
				}
				this.adapter.log.warn(
					`[Tracker] CircleMap: State ${stateId} empty or not found, using default 'Circle'`,
				);
			} else {
				this.adapter.log.warn(`[Tracker] CircleMap: No circleId found, using default 'Circle'`);
			}
		} catch (e) {
			this.adapter.log.warn(`[Tracker] Error reading circle name: ${e.message}`);
		}
		return "Circle";
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
		const r = parseInt(hex.slice(1, 3), 16),
			g = parseInt(hex.slice(3, 5), 16),
			b = parseInt(hex.slice(5, 7), 16);
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
		const r = parseInt(hex.slice(1, 3), 16),
			g = parseInt(hex.slice(3, 5), 16),
			b = parseInt(hex.slice(5, 7), 16);
		return `#${[r, g, b]
			.map(v =>
				Math.max(0, Math.min(255, Math.round(v * factor)))
					.toString(16)
					.padStart(2, "0"),
			)
			.join("")}`;
	}
}

module.exports = TrackerCircleHtml;
