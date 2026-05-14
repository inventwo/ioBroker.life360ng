"use strict";

const I18N = {
	en: {
		allOn: "All on",
		allOff: "All off",
		from: "From",
		to: "To",
		lastPoint: "Last point",
		origin: "Start of the day",
		stopover: "Waypoint",
		currentPosition: "Current Position",
		mapSize: "Map size",
		route: "Route",
		places: "Life360 Places",
		myPlaces: "My Places",
		placesRadius: "Place radius",
		myPlacesRadius: "My Place radius",
		dayHighlight: "Day highlight",
		reload: "Reload",
	},
	de: {
		allOn: "Alle an",
		allOff: "Alle aus",
		from: "Von",
		to: "Bis",
		lastPoint: "Letzter Punkt",
		origin: "Tagesstart",
		stopover: "Wegpunkt",
		currentPosition: "Aktuelle Position",
		mapSize: "Kartengröße",
		route: "Route",
		places: "Life360 Orte",
		myPlaces: "Eigene Orte",
		placesRadius: "Ortsradius",
		myPlacesRadius: "Eigener Ortsradius",
		dayHighlight: "Tageshervorhebung",
		reload: "Neu laden",
	},
};

/**
 * Life360 Tracker - Route logger module
 * Records GPS routes as GeoJSON and generates HTML maps
 *
 * GeoJSON structure:
 *   allTime.geojson  → FeatureCollection with ALL features across all months (used for HTML map)
 *   currentYear.<MM>.geojson → FeatureCollection for the current month (backup / per-month access)
 *   Each Feature = one day (LineString), coordinates: [longitude, latitude, timestamp]
 *
 * Runtime config states (writable, override adapter.config):
 *   tracker.config.enabled
 *   tracker.config.minDistance
 *   tracker.config.color.pageBg / headerBg / headerBorder / routeWeight / routeOpacity
 */
class Tracker {
	/**
	 * @param {import('../main')} adapter - ioBroker adapter instance
	 */
	constructor(adapter) {
		this.adapter = adapter;
		this.config = {};
		this._lang = "en";
		this.subscriptions = [];
		this._personIdCache = {};
		// UUID-based mapping: latState-ID → person object
		this._latStateMap = {};
		// Relative IDs of tracker.config.* states (for onStateChange routing)
		this._configStateIds = new Set();
		// Last date on which retention purge was executed (YYYY-MM-DD)
		this._lastPurgeDate = null;
		// Web adapter access (resolved once in init())
		this._webPort = 8082;
		this._webSecure = false;
		// Cached places data for map rendering (refreshed before each HTML generation)
		this._placesCache = { life360: [], myPlaces: [] };
		// Startup timestamp used as cache-buster for shared static files
		this._startupTs = 0;
	}

	// ─────────────────────────────────────────────
	// PUBLIC
	// ─────────────────────────────────────────────

	/**
	 * Initializes the tracker
	 *
	 * @returns {Promise<void>} Resolves, wenn die Initialisierung aller Personen abgeschlossen ist.
	 */
	async init() {
		this._loadConfig();
		await this._resolveWebAccess();

		// Detect ioBroker system language (fall back to "en" for anything non-German)
		try {
			const sysCfg = await this.adapter.getForeignObjectAsync("system.config");
			const sysLang = sysCfg?.common?.language || "en";
			this._lang = sysLang === "de" ? "de" : "en";
		} catch {
			this._lang = "en";
		}

		// Always create config states (so user can toggle enabled even when disabled)
		await this._ensureConfigStates();

		// Re-read config: state values take priority over adapter.config
		await this._loadConfigFromStates();

		if (!this.config.enabled) {
			this.adapter.log.info("[Tracker] Route logger disabled");
			return;
		}

		await this._writeSharedFiles();
		this._startupTs = Date.now();
		await this._syncPeople();

		const activePeople = this.config.people.filter(p => p.enabled);
		if (activePeople.length === 0) {
			this.adapter.log.info("[Tracker] No persons enabled");
			return;
		}

		for (const person of activePeople) {
			await this._initPerson(person);
		}

		// Build family map on startup (objects + HTML)
		const familyPeople = activePeople.filter(p => p.familyMap);
		if (familyPeople.length > 0) {
			await this._ensureChannels(this.config.familyName);
			await this._updateFamilyMap();
		}

		// Run initial retention purge on startup
		if (this.config.retentionDays > 0) {
			await this._dailyPurgeAll();
		}
		this._lastPurgeDate = new Date().toISOString().slice(0, 10);

		// Handle per-person clearRecordings flags from the people table
		const peopleWithClearFlag = this.config.people.filter(p => p.clearRecordings);
		if (peopleWithClearFlag.length > 0) {
			await this._clearAllRecordings(peopleWithClearFlag);
			const resetPeople = this.config.people.map(p => ({ ...p, clearRecordings: false }));
			this.config.people = resetPeople;
			await this.adapter.updateConfig({ tracker_people: resetPeople });
		}

		this.adapter.log.info(`[Tracker] Initialized (${activePeople.length} person(s))`);
	}

	/**
	 * Stops the tracker and cleans up subscriptions
	 *
	 * @returns {void} Gibt nichts zurück.
	 */
	stop() {
		for (const sub of this.subscriptions) {
			this.adapter.unsubscribeForeignStates(sub);
		}
		for (const id of this._configStateIds) {
			this.adapter.unsubscribeStates(id);
		}
		this.subscriptions = [];
		this._latStateMap = {};
		this._configStateIds = new Set();
		this.adapter.log.info("[Tracker] Stopped");
	}

	// ─────────────────────────────────────────────
	// CONFIG
	// ─────────────────────────────────────────────

	/**
	 * Returns the translated string for the given key based on the detected system language.
	 *
	 * @param {string} key - Key from the I18N map
	 * @returns {string} Translated string, falls back to English if not found
	 */
	_t(key) {
		return (I18N[this._lang] || I18N.en)[key] || I18N.en[key] || key;
	}

	/**
	 * Loads the base configuration from adapter.config (no state reads here)
	 *
	 * @returns {void} Updates this.config from the adapter configuration.
	 */
	_loadConfig() {
		const c = this.adapter.config;
		this.config = {
			enabled: c.tracker_enabled ?? false,
			minDistance: c.tracker_min_distance ?? 20,
			pollInterval: (() => {
				const pi = Number(c.life360_polling_interval ?? 60);
				return pi > 3600 ? Math.round(pi / 1000) : pi;
			})(),
			namespace: this.adapter.namespace,
			people: c.tracker_people || [],
			familyName: (c.tracker_family_name || "circle").toLowerCase().replace(/\s+/g, "_"),
			mapColors: {
				pageBg: c.tracker_color_page_bg || "#1a1a2e",
				headerBg: c.tracker_color_header_bg || "#16213e",
				headerBorder: c.tracker_color_header_border || "#0f3460",
				routeWeight: c.tracker_route_weight ?? 4,
				routeOpacity: c.tracker_route_opacity ?? 0.85,
				markerOpacity: c.tracker_marker_opacity ?? 1,
				markerSize: c.tracker_marker_size ?? 1,
				popupOpacity: c.tracker_popup_opacity ?? 1,
				showPlaces: c.tracker_show_places ?? false,
				placesColor: c.tracker_places_color || "#db8158",
				placesFlagSize: c.tracker_places_flag_size ?? 1.0,
				placesFlagOpacity: c.tracker_places_flag_opacity ?? 1.0,
				showMyPlaces: c.tracker_show_myplaces ?? false,
				myPlacesColor: c.tracker_myplaces_color || "#996a53",
				myPlacesFlagSize: c.tracker_myplaces_flag_size ?? 1.0,
				myPlacesFlagOpacity: c.tracker_myplaces_flag_opacity ?? 1.0,
			},
			familyRoutesEnabled: c.tracker_family_routes_enabled ?? true,
			familyMapHeaderName: c.family_map_header_name || "",
			retentionDays: c.tracker_retention_days ?? 0,
			defaultDays: c.tracker_default_days ?? 1,
		};
	}

	/**
	 * Defines all tracker.config.* states with their metadata and default values.
	 * Default value = current this.config value (set by _loadConfig from adapter.config).
	 *
	 * @returns {Array<{id:string, value:unknown, meta:object}>} Gibt ein Array mit Konfigurations-State-Definitionen zurück.
	 */
	_configStateDefs() {
		return [
			{
				id: "tracker.config.enabled",
				value: this.config.enabled,
				meta: { name: "Route logger enabled", type: "boolean", role: "switch", read: true, write: true },
			},
		];
	}

	/**
	 * Creates tracker.config.* channel + states if they do not exist yet,
	 * and subscribes to changes so onStateChange can react.
	 * On first run the adapter.config value is used; afterwards the stored state value wins.
	 *
	 * @returns {Promise<void>} Resolves, nachdem alle tracker.config.* States erstellt und abonniert wurden.
	 */
	async _ensureConfigStates() {
		const ns = this.config.namespace;

		await this.adapter.setObjectNotExistsAsync(`${ns}.tracker`, {
			type: "device",
			common: { name: "Tracker / Route logger" },
			native: {},
		});
		await this.adapter.setObjectNotExistsAsync(`${ns}.tracker.config`, {
			type: "channel",
			common: { name: "Tracker configuration" },
			native: {},
		});

		for (const def of this._configStateDefs()) {
			const fullId = `${ns}.${def.id}`;
			const existing = await this.adapter.getObjectAsync(fullId);
			if (!existing) {
				// First run: create with value from adapter.config
				await this.adapter.setObjectAsync(fullId, {
					type: "state",
					common: { ...def.meta },
					native: {},
				});
				this.adapter.log.debug(`[Tracker] Config state created: ${def.id}`);
			}
			// Bei jedem Start: State mit aktuellem Config-Wert überschreiben (ack=true)
			await this.adapter.setStateAsync(fullId, def.value, true);
			this.adapter.log.debug(`[Tracker] Config state synced: ${def.id} = ${def.value}`);
			// Subscribe to own states (without namespace prefix)
			this.adapter.subscribeStates(def.id);
			this._configStateIds.add(def.id);
		}
	}

	/**
	 * Reads all tracker.config.* states and merges them into this.config.
	 * State values override adapter.config values.
	 * Called once during init(), after _ensureConfigStates().
	 *
	 * @returns {Promise<void>} Resolves, nachdem alle Config-State-Werte gelesen und übernommen wurden.
	 */
	async _loadConfigFromStates() {
		const ns = this.config.namespace;
		const get = async id => {
			const s = await this.adapter.getStateAsync(`${ns}.${id}`);
			return s?.val ?? null;
		};

		const enabled = await get("tracker.config.enabled");

		if (enabled !== null) {
			this.config.enabled = !!enabled;
		}

		this.adapter.log.debug(`[Tracker] Config loaded from states (enabled=${this.config.enabled})`);
	}

	/**
	 * Applies a single tracker.config.* state change at runtime.
	 * Color changes immediately re-render all maps.
	 *
	 * @param {string} shortId - Relative ID without namespace (e.g. "tracker.config.enabled")
	 * @param {unknown} val - New value
	 * @returns {Promise<void>} Resolves, nachdem der Config-Wert übernommen und ggf. Karten neu gerendert wurden.
	 */
	async _applyConfigStateChange(shortId, val) {
		this.adapter.log.info(`[Tracker] Config state changed: ${shortId} = ${val}`);

		switch (shortId) {
			case "tracker.config.enabled":
				this.config.enabled = !!val;
				if (!this.config.enabled) {
					this.adapter.log.info("[Tracker] Route logger disabled. Restart adapter to reactivate.");
				} else {
					this.adapter.log.info("[Tracker] Route logger enabled. Restart the adapter to start tracking.");
				}
				return; // no map re-render needed
			default:
				return;
		}
	}

	/**
	 * Re-renders all active person maps and the family map from their current allTime GeoJSON.
	 * Called when a map color setting changes at runtime.
	 *
	 * @returns {Promise<void>} Resolves, nachdem alle Karten neu gerendert wurden.
	 */
	async _rerenderAllMaps() {
		const ns = this.config.namespace;
		const activePeople = this.config.people.filter(p => p.enabled);

		for (const person of activePeople) {
			const paths = this._getPaths(person.name);
			const existing = await this.adapter.getStateAsync(`${ns}.${paths.allTime}`);
			if (!existing?.val) {
				continue;
			}
			try {
				const fc = JSON.parse(existing.val);
				await this._writeMap(person, fc);
			} catch (e) {
				this.adapter.log.warn(`[Tracker:${person.name}] Re-render error: ${e.message}`);
			}
		}

		const familyPeople = activePeople.filter(p => p.familyMap);
		if (familyPeople.length > 0) {
			await this._updateFamilyMap();
		}

		this.adapter.log.debug("[Tracker] All maps re-rendered after color config change");
	}

	// ─────────────────────────────────────────────
	// PERSON SYNC
	// ─────────────────────────────────────────────

	/**
	 * Synchronizes persons from Life360 with the adapter config
	 *
	 * @returns {Promise<void>} Resolves, nachdem alle Personen synchronisiert wurden.
	 */
	async _syncPeople() {
		const objects = await this.adapter.getObjectViewAsync("system", "channel", {
			startkey: `${this.config.namespace}.people.`,
			endkey: `${this.config.namespace}.people.\u9999`,
		});

		const knownNames = objects.rows.map(r => r.value?.common?.name).filter(Boolean);

		const defaultColors = ["#4a90e2", "#e94560", "#4caf50", "#ff9800", "#9c27b0", "#00bcd4"];
		const people = [...(this.config.people || [])];
		let changed = false;

		for (const name of knownNames) {
			if (!people.find(p => p.name === name)) {
				people.push({
					name,
					enabled: false,
					minDistance: 0,
					color: defaultColors[people.length % defaultColors.length],
					ownMap: true,
					familyMap: true,
				});
				changed = true;
				this.adapter.log.info(`[Tracker] New person found: ${name}`);
			}
		}

		if (changed) {
			this.config.people = people;
			await this.adapter.updateConfig({ tracker_people: people });
		}
	}

	// ─────────────────────────────────────────────
	// CHANNEL STRUCTURE
	// ─────────────────────────────────────────────

	/**
	 * Creates the object structure for a person (or family identifier)
	 *
	 * @param {string} name - Display name or family identifier
	 * @returns {Promise<void>} Resolved after all channel and state objects have been created
	 */
	async _ensureChannels(name) {
		const ns = this.config.namespace;
		const now = new Date();
		const month = String(now.getMonth() + 1).padStart(2, "0");
		const safe = name.toLowerCase().replace(/\s+/g, "_"); // ← NEU

		await this.adapter.extendObjectAsync(ns, {
			type: "meta",
			common: { name: "User files for life360ng", type: "meta.user" },
			native: {},
		});
		await this.adapter.setObjectNotExistsAsync(`${ns}.tracker`, {
			type: "device",
			common: { name: "Tracker / Route logger" },
			native: {},
		});
		await this.adapter.setObjectNotExistsAsync(`${ns}.tracker.${safe}`, {
			// ← safe
			type: "channel",
			common: { name },
			native: {}, // name bleibt als Anzeigename
		});
		await this.adapter.setObjectNotExistsAsync(`${ns}.tracker.${safe}.allTime`, {
			type: "channel",
			common: { name: "All time" },
			native: {},
		});
		await this.adapter.setObjectNotExistsAsync(`${ns}.tracker.${safe}.currentYear`, {
			type: "channel",
			common: { name: "Current year" },
			native: {},
		});
		await this.adapter.setObjectNotExistsAsync(`${ns}.tracker.${safe}.currentYear.${month}`, {
			type: "channel",
			common: { name: `Month ${month}` },
			native: {},
		});
		await this.adapter.setObjectNotExistsAsync(`${ns}.tracker.${safe}.mapSize`, {
			type: "state",
			common: {
				name: `${name} - Map file size`,
				type: "number",
				role: "value",
				unit: "KB",
				read: true,
				write: false,
			},
			native: {},
		});
	}

	// ─────────────────────────────────────────────
	// INITIALIZE PERSON
	// ─────────────────────────────────────────────

	/**
	 * Initializes tracking for a person
	 *
	 * @param {{name:string, color:string, enabled:boolean, ownMap:boolean, familyMap:boolean}} person
	 * @returns {Promise<void>} Resolved after subscription, GeoJSON state, and HTML map have been initialized
	 */
	async _initPerson(person) {
		await this._ensureChannels(person.name);

		const paths = this._getPaths(person.name);
		const personId = await this._resolvePersonId(person.name);

		// Create/update URL state
		await this._ensureState(paths.url, this._buildUrl(person), {
			name: `${person.name} - Map URL`,
			type: "string",
			role: "url",
			read: true,
			write: false,
		});

		// Create/update local URL state (with ioBroker server IP + web adapter port)
		await this._ensureState(paths.urlLocal, this._buildLocalUrl(this._buildUrl(person)), {
			name: `${person.name} - Map URL (local)`,
			type: "string",
			role: "url",
			read: true,
			write: false,
		});

		// Load current location for initial point
		const latState = await this.adapter.getForeignStateAsync(
			`${this.config.namespace}.people.${personId}.latitude`,
		);
		const longState = await this.adapter.getForeignStateAsync(
			`${this.config.namespace}.people.${personId}.longitude`,
		);

		// ── allTime state ──────────────────────────────────
		const existingAllTime = await this.adapter.getStateAsync(`${this.config.namespace}.${paths.allTime}`);

		let allTimeFC;
		if (!existingAllTime || existingAllTime.val == null) {
			// Brand new allTime state: seed with current location if available
			allTimeFC = this._emptyFeatureCollection();
			if (latState?.val != null && longState?.val != null) {
				const seedTs = latState.ts || Date.now();
				this._addPointToFC(allTimeFC, longState.val, latState.val, seedTs);
				this.adapter.log.debug(`[Tracker:${person.name}] Seeded allTime with current location`);
			}
		} else {
			try {
				allTimeFC = JSON.parse(existingAllTime.val);
				// If today's feature is missing entirely, seed it with current location
				const today = new Date().toISOString().slice(0, 10);
				const todayFeat = allTimeFC.features.find(f => f.properties.date === today);
				if (!todayFeat && latState?.val != null && longState?.val != null) {
					const seedTs = latState.ts || Date.now();
					this._addPointToFC(allTimeFC, longState.val, latState.val, seedTs);
					this.adapter.log.debug(`[Tracker:${person.name}] Seeded today's feature with current location`);
				}
			} catch (e) {
				this.adapter.log.warn(`[Tracker:${person.name}] allTime parse error: ${e.message}`);
				allTimeFC = this._emptyFeatureCollection();
			}
		}

		// Always ensure the object definition exists and write the current state value.
		// This recreates a missing allTime.geojson object even when a state value is still
		// present in the state DB (state and object DB can diverge after object cleanup).
		await this._ensureState(paths.allTime, JSON.stringify(allTimeFC), {
			name: `GeoJSON ${person.name} (all time)`,
			type: "string",
			role: "json",
			read: true,
			write: false,
		});

		// ── monthly state ──────────────────────────────────
		const existingMonth = await this.adapter.getStateAsync(`${this.config.namespace}.${paths.geojson}`);

		if (!existingMonth || existingMonth.val == null) {
			const monthFC = this._emptyFeatureCollection();
			if (latState?.val != null && longState?.val != null) {
				const seedTs = latState.ts || Date.now();
				this._addPointToFC(monthFC, longState.val, latState.val, seedTs);
			}
			await this._ensureState(paths.geojson, JSON.stringify(monthFC), {
				name: `GeoJSON ${person.name}`,
				type: "string",
				role: "json",
				read: true,
				write: false,
			});
		}

		// HTML is always rendered from allTime (which now contains at least one point)
		await this._writeMap(person, allTimeFC);

		// Register subscription via UUID and store in _latStateMap
		const latId = `${this.config.namespace}.people.${personId}.latitude`;
		if (!this.subscriptions.includes(latId)) {
			this.adapter.subscribeForeignStates(latId);
			this.subscriptions.push(latId);
		}
		this._latStateMap[latId] = person;

		this.adapter.log.debug(`[Tracker:${person.name}] Initialized (latId=${latId})`);
	}

	// ─────────────────────────────────────────────
	// STATE CHANGE HANDLER
	// ─────────────────────────────────────────────

	/**
	 * Handles state changes (call from main.js)
	 *
	 * @param {string} id - State ID
	 * @param {ioBroker.State|null|undefined} state - New state
	 * @returns {Promise<void>} Resolved after the new GPS point has been processed and the map updated
	 */
	async onStateChange(id, state) {
		if (!state) {
			return;
		}

		// ── tracker.config.* state changed ────────────────
		// Config states are written by the user (ack=false) → handle before the ack guard
		const shortId = id.startsWith(`${this.config.namespace}.`) ? id.slice(this.config.namespace.length + 1) : null;
		if (shortId && this._configStateIds.has(shortId)) {
			if (state.ack === false) {
				await this._applyConfigStateChange(shortId, state.val);
			}
			return;
		}

		// ── GPS latitude update (only ack=true states from Life360) ───
		if (state.ack === false) {
			return;
		}

		// ── GPS latitude update ────────────────────────────
		const person = this._latStateMap[id];
		if (!person) {
			return;
		}

		const lat = state.val;
		if (lat == null) {
			return;
		}

		const personId = await this._resolvePersonId(person.name);
		const longState = await this.adapter.getForeignStateAsync(
			`${this.config.namespace}.people.${personId}.longitude`,
		);
		const long = longState?.val;
		if (long == null) {
			return;
		}

		const paths = this._getPaths(person.name);
		const ns = this.config.namespace;

		// ── Load allTime FC ────────────────────────────────
		let allTimeFC;
		const existingAllTime = await this.adapter.getStateAsync(`${ns}.${paths.allTime}`);
		if (!existingAllTime || existingAllTime.val == null) {
			allTimeFC = this._emptyFeatureCollection();
		} else {
			try {
				allTimeFC = JSON.parse(existingAllTime.val);
			} catch (e) {
				this.adapter.log.warn(`[Tracker:${person.name}] allTime parse error: ${e.message}`);
				allTimeFC = this._emptyFeatureCollection();
			}
		}

		// Only proceed if minimum distance is exceeded (checked against allTime)
		// Per-person minDistance overrides global setting when > 0
		const effectiveMinDistance = person.minDistance > 0 ? person.minDistance : this.config.minDistance;
		if (!this._shouldUpdate(allTimeFC, lat, long, effectiveMinDistance)) {
			return;
		}

		const ts = Date.now();

		// ── Update allTime FC ──────────────────────────────
		this._addPointToFC(allTimeFC, long, lat, ts);
		await this.adapter.setStateAsync(`${ns}.${paths.allTime}`, JSON.stringify(allTimeFC), true);

		// ── Update monthly FC ──────────────────────────────
		let monthFC;
		const existingMonth = await this.adapter.getStateAsync(`${ns}.${paths.geojson}`);

		if (!existingMonth || existingMonth.val == null) {
			// Month change: create new channel structure + fresh monthly FC
			await this._ensureChannels(person.name);
			monthFC = this._emptyFeatureCollection();
			this._addPointToFC(monthFC, long, lat, ts);
			await this._ensureState(paths.geojson, JSON.stringify(monthFC), {
				name: `GeoJSON ${person.name}`,
				type: "string",
				role: "json",
				read: true,
				write: false,
			});
		} else {
			try {
				monthFC = JSON.parse(existingMonth.val);
			} catch (e) {
				this.adapter.log.warn(`[Tracker:${person.name}] monthly GeoJSON parse error: ${e.message}`);
				monthFC = this._emptyFeatureCollection();
			}
			this._addPointToFC(monthFC, long, lat, ts);
			await this.adapter.setStateAsync(`${ns}.${paths.geojson}`, JSON.stringify(monthFC), true);
		}

		// ── Daily retention purge (on day change) ────────
		const today = new Date().toISOString().slice(0, 10);
		if (this.config.retentionDays > 0 && this._lastPurgeDate && today !== this._lastPurgeDate) {
			this._lastPurgeDate = today;
			await this._dailyPurgeAll();
			// Reload allTimeFC after purge (may have been trimmed)
			const purgedState = await this.adapter.getStateAsync(`${ns}.${paths.allTime}`);
			if (purgedState?.val) {
				try {
					allTimeFC = JSON.parse(purgedState.val);
				} catch {
					/* keep existing */
				}
			}
		}

		// HTML always rendered from allTime
		await this._writeMap(person, allTimeFC);
		if (person.familyMap) {
			await this._updateFamilyMap();
		}
	}

	// ─────────────────────────────────────────────
	// FAMILY MAP
	// ─────────────────────────────────────────────

	/**
	 * Updates the combined family map
	 *
	 * @returns {Promise<void>} Resolved after the family map has been updated
	 */
	async _updateFamilyMap() {
		const ns = this.config.namespace;
		const activePeople = this.config.people.filter(p => p.enabled && p.familyMap);
		if (activePeople.length === 0) {
			return;
		}

		// Collect allTime and monthly GeoJSONs from all persons
		const personFCs = [];
		const personMonthFCs = [];
		for (const person of activePeople) {
			const paths = this._getPaths(person.name);
			const existing = await this.adapter.getStateAsync(`${ns}.${paths.allTime}`);
			if (!existing?.val) {
				continue;
			}
			try {
				const fc = JSON.parse(existing.val);
				for (const f of fc.features || []) {
					f.properties.color = f.properties.color || person.color;
					f.properties.name = f.properties.name || person.name;
				}
				personFCs.push({ person: { ...person, circleId: person.circleId || this.config.circleId }, fc });
			} catch (e) {
				this.adapter.log.warn(`[Tracker:circle] Parse error for ${person.name}: ${e.message}`);
			}

			// Collect monthly GeoJSON for this person
			const existingMonth = await this.adapter.getStateAsync(`${ns}.${paths.geojson}`);
			if (existingMonth?.val) {
				try {
					const monthFC = JSON.parse(existingMonth.val);
					for (const f of monthFC.features || []) {
						f.properties.color = f.properties.color || person.color;
						f.properties.name = f.properties.name || person.name;
					}
					personMonthFCs.push(...(monthFC.features || []));
				} catch (e) {
					this.adapter.log.warn(`[Tracker:circle] Monthly parse error for ${person.name}: ${e.message}`);
				}
			}
		}

		if (personFCs.length === 0) {
			return;
		}

		// Assemble family FeatureCollections
		const familyFC = {
			type: "FeatureCollection",
			features: personFCs.flatMap(({ fc }) => fc.features || []),
		};
		const familyMonthFC = {
			type: "FeatureCollection",
			features: personMonthFCs,
		};

		await this._ensureChannels(this.config.familyName);
		const familyPaths = this._getPaths(this.config.familyName);

		await this._ensureState(familyPaths.allTime, JSON.stringify(familyFC), {
			name: "GeoJSON Family (all time)",
			type: "string",
			role: "json",
			read: true,
			write: false,
		});

		await this._ensureState(familyPaths.geojson, JSON.stringify(familyMonthFC), {
			name: "GeoJSON Family",
			type: "string",
			role: "json",
			read: true,
			write: false,
		});

		await this._ensureState(familyPaths.url, this._buildFamilyUrl(), {
			name: "Family - Map URL",
			type: "string",
			role: "url",
			read: true,
			write: false,
		});

		await this._ensureState(familyPaths.urlLocal, this._buildLocalUrl(this._buildFamilyUrl()), {
			name: "Family - Map URL (local)",
			type: "string",
			role: "url",
			read: true,
			write: false,
		});

		await this._refreshPlacesCache();
		let html = await this._generateFamilyHTML(personFCs);
		const sizeKB = Math.round((Buffer.byteLength(html, "utf8") / 1024) * 100) / 100;
		html = html.replace("__MAPSIZE__", `${sizeKB} KB`);
		await new Promise((resolve, reject) => {
			this.adapter.writeFile(ns, familyPaths.filePath, html, async err => {
				// ← async NEU
				if (err) {
					this.adapter.log.error(`[Tracker:circle] writeFile error: ${err}`);
					reject(err);
				} else {
					// ── NEU ──────────────────────────────────────────
					await this.adapter.setStateAsync(`${ns}.tracker.${this.config.familyName}.mapSize`, {
						val: sizeKB,
						ack: true,
					});
					// ─────────────────────────────────────────────────
					resolve();
				}
			});
		});

		this.adapter.log.debug("[Tracker:circle] Circle map updated");
	}

	// ─────────────────────────────────────────────
	// HTML – SINGLE MAP
	// ─────────────────────────────────────────────

	/**
	 * Writes the HTML map as a file
	 *
	 * @param {{name:string, color:string}} person
	 * @param {object} fc - FeatureCollection (allTime)
	 * @returns {Promise<void>} Resolved after the HTML file has been successfully written to the ioBroker filesystem
	 */

	/**
	 * Refreshes the internal places cache from ioBroker states (Life360 places) and adapter config (MyPlaces).
	 * Called once before each HTML map generation.
	 *
	 * @returns {Promise<void>}
	 */
	async _refreshPlacesCache() {
		const c = this.config.mapColors;
		if (!c.showPlaces && !c.showMyPlaces) {
			this._placesCache = { life360: [], myPlaces: [] };
			return;
		}

		// MyPlaces from adapter config
		this._placesCache.myPlaces = c.showMyPlaces
			? (this.adapter.config.places || [])
					.map(p => ({
						name: String(p.name || ""),
						lat: Number(p.latitude),
						lng: Number(p.longitude),
						radius: Number(p.radius) || 0,
					}))
					.filter(p => p.name && !isNaN(p.lat) && !isNaN(p.lng) && (p.lat !== 0 || p.lng !== 0))
			: [];

		// Life360 places from ioBroker states
		if (c.showPlaces) {
			const ns = this.config.namespace;
			try {
				const result = await this.adapter.getObjectViewAsync("system", "channel", {
					startkey: `${ns}.places.`,
					endkey: `${ns}.places.\u9999`,
				});
				const depth = ns.split(".").length + 2;
				const places = [];
				for (const row of result?.rows || []) {
					if (row.id.split(".").length !== depth) {
						continue;
					}
					const [latState, lngState, nameState] = await Promise.all([
						this.adapter.getStateAsync(`${row.id}.latitude`),
						this.adapter.getStateAsync(`${row.id}.longitude`),
						this.adapter.getStateAsync(`${row.id}.name`),
					]);
					const lat = Number(latState?.val);
					const lng = Number(lngState?.val);
					const name = String(nameState?.val || "");
					if (name && !isNaN(lat) && !isNaN(lng) && (lat !== 0 || lng !== 0)) {
						const radiusState = await this.adapter.getStateAsync(`${row.id}.radius`);
						places.push({ name, lat, lng, radius: Number(radiusState?.val) || 0 });
					}
				}
				this._placesCache.life360 = places;
				this.adapter.log.debug(
					`[Tracker] Places cache: ${places.length} Life360 places, ${this._placesCache.myPlaces.length} own places`,
				);
			} catch (e) {
				this.adapter.log.warn(`[Tracker] Failed to load Life360 places for map: ${e.message}`);
				this._placesCache.life360 = [];
			}
		} else {
			this._placesCache.life360 = [];
		}
	}

	/**
	 * Writes the HTML map as a file
	 *
	 * @param {{name:string, color:string}} person
	 * @param {object} fc - FeatureCollection (allTime)
	 * @returns {Promise<void>} Resolved after the HTML file has been successfully written to the ioBroker filesystem
	 */ async _writeMap(person, fc) {
		await this._refreshPlacesCache();
		// If ownMap is false, do not include route data in HTML (but keep in GeoJSON)
		let html = String(this._generateHTML(person, fc, person.ownMap !== false));
		const sizeKB = Math.round((Buffer.byteLength(html, "utf8") / 1024) * 100) / 100;
		html = html.replace("__MAPSIZE__", `${sizeKB} KB`);
		const paths = this._getPaths(person.name);
		return new Promise((resolve, reject) => {
			this.adapter.writeFile(this.config.namespace, paths.filePath, html, async err => {
				if (err) {
					this.adapter.log.error(`[Tracker:${person.name}] writeFile error: ${err}`);
					reject(err);
				} else {
					const safe = person.name.toLowerCase().replace(/\s+/g, "_");
					await this.adapter.setStateAsync(`${this.config.namespace}.tracker.${safe}.mapSize`, {
						val: sizeKB,
						ack: true,
					});
					const total = (fc.features || []).reduce((s, f) => s + (f.geometry?.coordinates?.length || 0), 0);
					this.adapter.log.debug(`[Tracker:${person.name}] Map updated (${total} points total)`);
					resolve();
				}
			});
		});
	}

	/**
	 * Generates the HTML content of the single-person map with day dropdown
	 *
	 * @param {{name:string, color:string}} person
	 * @param {object} fc - FeatureCollection (allTime)
	 * @param includeRoute
	 * @returns {string} Complete HTML string of the Leaflet single-person map with day dropdown
	 */
	_generateHTML(person, fc, includeRoute = true) {
		const c = this.config.mapColors;
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

		const featuresData = features.map(f => {
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
		});

		const personKey = person.id ? String(person.id) : person.name.replace(/[^a-zA-Z0-9]/g, "_");
		const headerFg = this._getContrastText(c.headerBg);
		const controlBg = this._scaleColor(c.headerBg, 0.82);
		const controlBorder = this._scaleColor(c.headerBg, 0.62);
		const controlHoverBg = this._scaleColor(c.headerBg, 0.72);
		const ns = this.config.namespace;
		const colorScheme = headerFg === "#111111" ? "light" : "dark";

		const trackerConfig = {
			routeWeight: c.routeWeight,
			routeOpacity: c.routeOpacity,
			markerOpacity: c.markerOpacity,
			markerSize: c.markerSize,
			showPlaces: c.showPlaces,
			placesColor: c.placesColor,
			placesFlagSize: c.placesFlagSize,
			placesFlagOpacity: c.placesFlagOpacity,
			showMyPlaces: c.showMyPlaces,
			myPlacesColor: c.myPlacesColor,
			myPlacesFlagSize: c.myPlacesFlagSize,
			myPlacesFlagOpacity: c.myPlacesFlagOpacity,
		};

		const trackerData = {
			mode: "person",
			features: featuresData,
			selDate,
			today,
			refresh,
			personKey,
			storageKey: `tracker_showRoute_${personKey}`,
			defaultDays: this.config.defaultDays,
			color,
			dark,
			firstName,
			placesData: this._placesCache.life360,
			myPlacesData: this._placesCache.myPlaces,
			labels: {
				from: this._t("from"),
				to: this._t("to"),
				route: this._t("route"),
				places: this._t("places"),
				myPlaces: this._t("myPlaces"),
				mapSize: this._t("mapSize"),
				lastPoint: this._t("lastPoint"),
				origin: this._t("origin"),
				stopover: this._t("stopover"),
				currentPosition: this._t("currentPosition"),
			},
		};

		const placesMenuHtml = c.showPlaces
			? `\n\t\t\t<label><input type="checkbox" id="menuPlaces" style="accent-color:${c.placesColor}"> ${this._t("places")}</label>\n\t\t\t<label style="padding-left:14px"><input type="checkbox" id="menuPlacesRadius" style="accent-color:${c.placesColor}"> ${this._t("placesRadius")}</label>`
			: "";
		const myPlacesMenuHtml = c.showMyPlaces
			? `\n\t\t\t<label><input type="checkbox" id="menuMyPlaces" style="accent-color:${c.myPlacesColor}"> ${this._t("myPlaces")}</label>\n\t\t\t<label style="padding-left:14px"><input type="checkbox" id="menuMyPlacesRadius" style="accent-color:${c.myPlacesColor}"> ${this._t("myPlacesRadius")}</label>`
			: "";

		return (
			`<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="${refresh}">
<title>${firstName} \u2013 Tracker</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<link rel="stylesheet" href="/${ns}/tracker/tracker-map.css?v=${this._startupTs}"/>
<style>:root{--page-bg:${c.pageBg};--header-bg:${c.headerBg};--header-border:${c.headerBorder};--fg:${headerFg};--ctrl-bg:${controlBg};--ctrl-border:${controlBorder};--ctrl-hover:${controlHoverBg};--popup-opacity:${c.popupOpacity}}body,input[type=date]{color-scheme:${colorScheme}}</style>
</head>
<body class="mode-person">
<div id="header">
	<div id="header-left">
		<h2>\uD83D\uDCCD ${firstName}</h2>
		<span id="headerInfo" style="display:none"></span>
	</div>
	<div id="header-right">
		<span class="range-label" id="labelFrom">${this._t("from")}</span>
		<input type="date" id="dateFrom">
		<span class="range-label" id="labelTo">${this._t("to")}</span>
		<input type="date" id="dateTo">
		<div id="hamMenu">
			<button type="button" id="hamBtn">&#9776;</button>
			<div id="hamPanel">
				<label><input type="checkbox" id="menuRoute"> ${this._t("route")}</label>${placesMenuHtml}${myPlacesMenuHtml}
				<label><input type="checkbox" id="menuDayHighlight"> ${this._t("dayHighlight")}</label>
				<label><input type="checkbox" id="menuFooter"> Footer</label>
				<label><input type="checkbox" id="menuMapSize"> ${this._t("mapSize")}</label>
				<hr style="border:none;border-top:1px solid var(--ctrl-border);margin:4px 0">
				<button type="button" class="legend-btn" style="width:100%" onclick="location.reload()">&#8635; ${this._t("reload")}</button>
			</div>
		</div>
	</div>
</div>
<div id="map"></div>
<div id="footer">
	<div id="legend" style="display:flex;align-items:center;gap:20px;flex-wrap:wrap">
		<span class="leg-entry"><svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="#000" stroke="#fff" stroke-width="1.5" opacity=".7"/></svg>${this._t("origin")}</span>
		<span class="leg-entry"><svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5" fill="#888" stroke="#fff" stroke-width="1.5" opacity=".7"/></svg>${this._t("stopover")}</span>
		<span class="leg-entry"><svg width="14" height="18" viewBox="0 0 14 18"><path fill-rule="evenodd" d="M7 0C3.13 0 0 3.13 0 7c0 5.25 7 11 7 11s7-5.75 7-11c0-3.87-3.13-7-7-7z M4 7a3 3 0 1 0 6 0 3 3 0 0 0-6 0z" fill="currentColor" stroke="#fff" stroke-width=".8"/></svg>${this._t("currentPosition")}</span>
	</div>
	<span id="mapSizeLabel" style="margin-left:auto;display:none">${this._t("mapSize")}: __MAPSIZE__</span>
</div>
<script>window.TRACKER_CONFIG=${JSON.stringify(trackerConfig)};window.TRACKER_DATA=${JSON.stringify(trackerData)};</` +
			`script>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></` +
			`script>
<script src="/${ns}/tracker/tracker-map.js?v=${this._startupTs}"></` +
			`script>
</body>
</html>`
		);
	}

	// ─────────────────────────────────────────────
	// HTML – CIRCLE MAP
	// ─────────────────────────────────────────────

	/**
	 * Generates the HTML content of the circle map with dropdown and legend
	 *
	 * @param {{person:{name:string,color:string}, fc:object}[]} personFCs
	 * @returns {Promise<string>} Gibt den vollständigen HTML-String der Leaflet-Kreisekarte zurück.
	 */
	async _generateFamilyHTML(personFCs) {
		const c = this.config.mapColors;
		const refresh = this.config.pollInterval + 10;

		const headerFg = this._getContrastText(c.headerBg);
		const controlBg = this._scaleColor(c.headerBg, 0.82);
		const controlHoverBg = this._scaleColor(c.headerBg, 0.72);
		const controlBorder = this._scaleColor(c.headerBg, 0.62);
		const subText = this._scaleColor(headerFg, 0.75);
		const ns = this.config.namespace;

		// --- Circle Map Header Name: user-defined, circle name, or fallback ---
		let circleName = "Circle";
		if (
			this.config.familyMapHeaderName &&
			typeof this.config.familyMapHeaderName === "string" &&
			this.config.familyMapHeaderName.trim()
		) {
			circleName = this.config.familyMapHeaderName.trim();
			this.adapter.log.debug(`[Tracker] CircleMap: using user-defined header name: ${circleName}`);
		} else {
			try {
				const ns = this.config.namespace;
				// Try to find a circleId from the person objects, then fall back to
				// querying the circles channel objects directly from the object store.
				const firstPerson = personFCs[0]?.person;
				let circleId = firstPerson?.circleId;
				if (!circleId && this.config.circleId) {
					circleId = this.config.circleId;
				}
				if (!circleId && this.config.people?.length > 0) {
					circleId = this.config.people[0]?.circleId;
				}

				if (!circleId) {
					// No circleId in config — query circle channels from object store
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
						circleName = state.val.trim();
					} else {
						this.adapter.log.warn(
							`[Tracker] CircleMap: State ${stateId} empty or not found, using default 'Circle'`,
						);
					}
				} else {
					this.adapter.log.warn(`[Tracker] CircleMap: No circleId found, using default 'Circle'`);
				}
			} catch (e) {
				this.adapter.log.warn(`[Tracker] Error reading circle name: ${e.message}`);
			}
		}

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
		const legendItemsHtml = uniquePeople
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

		const colorScheme = headerFg === "#111111" ? "light" : "dark";

		const trackerConfig = {
			routeWeight: c.routeWeight,
			routeOpacity: c.routeOpacity,
			markerOpacity: c.markerOpacity,
			markerSize: c.markerSize,
			showPlaces: c.showPlaces,
			placesColor: c.placesColor,
			placesFlagSize: c.placesFlagSize,
			placesFlagOpacity: c.placesFlagOpacity,
			showMyPlaces: c.showMyPlaces,
			myPlacesColor: c.myPlacesColor,
			myPlacesFlagSize: c.myPlacesFlagSize,
			myPlacesFlagOpacity: c.myPlacesFlagOpacity,
		};

		const trackerData = {
			mode: "circle",
			features: allFeatures,
			selDate,
			today,
			refresh,
			personKey: "circle",
			storageKey: "tracker_showRoute_circle",
			defaultDays: this.config.defaultDays,
			circleName,
			people: uniquePeople.map(p => ({ name: p.name, color: p.color })),
			placesData: this._placesCache.life360,
			myPlacesData: this._placesCache.myPlaces,
			labels: {
				from: this._t("from"),
				to: this._t("to"),
				route: this._t("route"),
				places: this._t("places"),
				myPlaces: this._t("myPlaces"),
				mapSize: this._t("mapSize"),
				lastPoint: this._t("lastPoint"),
				origin: this._t("origin"),
				stopover: this._t("stopover"),
				currentPosition: this._t("currentPosition"),
				allOn: this._t("allOn"),
				allOff: this._t("allOff"),
			},
		};

		const placesMenuHtml = c.showPlaces
			? `\n\t\t\t<label><input type="checkbox" id="menuPlaces" style="accent-color:${c.placesColor}"> ${this._t("places")}</label>\n\t\t\t<label style="padding-left:14px"><input type="checkbox" id="menuPlacesRadius" style="accent-color:${c.placesColor}"> ${this._t("placesRadius")}</label>`
			: "";
		const myPlacesMenuHtml = c.showMyPlaces
			? `\n\t\t\t<label><input type="checkbox" id="menuMyPlaces" style="accent-color:${c.myPlacesColor}"> ${this._t("myPlaces")}</label>\n\t\t\t<label style="padding-left:14px"><input type="checkbox" id="menuMyPlacesRadius" style="accent-color:${c.myPlacesColor}"> ${this._t("myPlacesRadius")}</label>`
			: "";

		return (
			`<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="${refresh}">
<title>${circleName} \u2013 Tracker</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<link rel="stylesheet" href="/${ns}/tracker/tracker-map.css?v=${this._startupTs}"/>
<style>:root{--page-bg:${c.pageBg};--header-bg:${c.headerBg};--header-border:${c.headerBorder};--fg:${headerFg};--ctrl-bg:${controlBg};--ctrl-border:${controlBorder};--ctrl-hover:${controlHoverBg};--sub-text:${subText};--popup-opacity:${c.popupOpacity}}body,input[type=date]{color-scheme:${colorScheme}}</style>
</head>
<body class="mode-circle">
<div id="header">
	<h2>\uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67 ${circleName}</h2>
	<div id="header-right">
		<div id="legendWrap">
			<div class="legend-actions">
				<button type="button" id="showAll" class="legend-btn">${this._t("allOn")}</button>
				<button type="button" id="hideAll" class="legend-btn">${this._t("allOff")}</button>
			</div>
			<div id="legendItems">${legendItemsHtml}</div>
		</div>
		<span class="range-label" id="labelFrom">${this._t("from")}</span>
		<input type="date" id="dateFrom">
		<span class="range-label" id="labelTo">${this._t("to")}</span>
		<input type="date" id="dateTo">
	</div>
	<div id="hamMenu">
		<button type="button" id="hamBtn">&#9776;</button>
		<div id="hamPanel">
			<label><input type="checkbox" id="menuRoute"> ${this._t("route")}</label>${placesMenuHtml}${myPlacesMenuHtml}
			<label><input type="checkbox" id="menuDayHighlight"> ${this._t("dayHighlight")}</label>
			<label><input type="checkbox" id="menuFooter"> Footer</label>
			<label><input type="checkbox" id="menuMapSize"> ${this._t("mapSize")}</label>
			<hr style="border:none;border-top:1px solid var(--ctrl-border);margin:4px 0">
			<button type="button" class="legend-btn" style="width:100%" onclick="location.reload()">&#8635; ${this._t("reload")}</button>
		</div>
	</div>
</div>
<div id="map"></div>
<div id="footer">
	<div id="legend" style="display:flex;align-items:center;gap:20px;flex-wrap:wrap">
		<span class="leg-entry"><svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="#000" stroke="#fff" stroke-width="1.5" opacity=".7"/></svg>${this._t("origin")}</span>
		<span class="leg-entry"><svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5" fill="#888" stroke="#fff" stroke-width="1.5" opacity=".7"/></svg>${this._t("stopover")}</span>
		<span class="leg-entry"><svg width="14" height="18" viewBox="0 0 14 18"><path fill-rule="evenodd" d="M7 0C3.13 0 0 3.13 0 7c0 5.25 7 11 7 11s7-5.75 7-11c0-3.87-3.13-7-7-7z M4 7a3 3 0 1 0 6 0 3 3 0 0 0-6 0z" fill="currentColor" stroke="#fff" stroke-width=".8"/></svg>${this._t("currentPosition")}</span>
	</div>
	<span id="mapSizeLabel" style="margin-left:auto;display:none">${this._t("mapSize")}: __MAPSIZE__</span>
</div>
<script>window.TRACKER_CONFIG=${JSON.stringify(trackerConfig)};window.TRACKER_DATA=${JSON.stringify(trackerData)};</` +
			`script>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></` +
			`script>
<script src="/${ns}/tracker/tracker-map.js?v=${this._startupTs}"></` +
			`script>
</body>
</html>`
		);
	}

	// ─────────────────────────────────────────────
	// SHARED MAP FILES
	// ─────────────────────────────────────────────

	/**
	 * Writes tracker-map.css and tracker-map.js into the adapter's tracker/ folder.
	 * Called once on adapter start (when tracker is enabled).
	 *
	 * @returns {Promise<void>}
	 */
	async _writeSharedFiles() {
		const ns = this.config.namespace;
		const writeFile = (path, content) =>
			new Promise((resolve, reject) => {
				this.adapter.writeFile(ns, path, content, err => (err ? reject(err) : resolve()));
			});
		await writeFile("tracker/tracker-map.css", this._sharedCss());
		await writeFile("tracker/tracker-map.js", this._sharedJs());
		this.adapter.log.debug("[Tracker] Shared map files written");
	}

	/**
	 * Returns the shared CSS for all tracker maps (uses CSS custom properties set per-page).
	 *
	 * @returns {string} CSS string
	 */
	_sharedCss() {
		return `*{margin:0;padding:0;box-sizing:border-box}
body{font-family:sans-serif;background:var(--page-bg,#1a1a2e);color:#eee;display:flex;flex-direction:column;height:100vh}
#header{padding:8px 14px;background:var(--header-bg,#16213e);display:flex;align-items:center;font-size:13px;line-height:1;border-bottom:2px solid var(--header-border,#0f3460);flex-wrap:wrap;gap:6px;min-height:44px}
#header-left{display:flex;align-items:baseline;gap:8px;white-space:nowrap}
#header h2{font-size:15px;line-height:1;color:var(--fg,#f5f5f5);margin:0;white-space:nowrap}
#header-right{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-left:auto}
#headerInfo{color:var(--fg,#f5f5f5);font-size:13px}
.range-label{color:var(--fg,#f5f5f5);font-size:12px;white-space:nowrap}
input[type=date]{background:var(--ctrl-bg);color:var(--fg,#f5f5f5);border:1px solid var(--ctrl-border);border-radius:4px;padding:3px 6px;font-size:13px;cursor:pointer}
#hamBtn{background:none;border:1px solid var(--ctrl-border);border-radius:4px;color:var(--fg,#f5f5f5);font-size:18px;line-height:1;padding:2px 8px;cursor:pointer}
#hamBtn:hover{background:var(--ctrl-hover)}
#hamMenu{position:relative}
#hamPanel{display:none;position:absolute;right:0;top:calc(100% + 4px);background:var(--header-bg,#16213e);border:1px solid var(--ctrl-border);border-radius:6px;padding:8px 12px;z-index:2000;min-width:170px;box-shadow:0 4px 12px rgba(0,0,0,.4)}
#hamPanel label{display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none;color:var(--fg,#f5f5f5);font-size:13px;padding:4px 0;white-space:nowrap}
#hamPanel input[type=checkbox]{margin:0;cursor:pointer}
#map{flex:1}
#footer{color:var(--fg,#f5f5f5);padding:5px 14px;background:var(--header-bg,#16213e);display:flex;align-items:center;gap:20px;font-size:12px;border-top:1px solid var(--header-border,#0f3460);flex-wrap:wrap;min-height:30px}
#footer .leg-entry{display:inline-flex;align-items:center;gap:6px}
#legendWrap{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
#legendItems{color:var(--sub-text,#c0c0c0);font-size:12px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.legend-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.legend-btn{background:var(--ctrl-bg);color:var(--fg,#f5f5f5);border:1px solid var(--ctrl-border);border-radius:4px;padding:4px 8px;font-size:12px;cursor:pointer;transition:background .15s,transform .05s}
.legend-btn:hover{background:var(--ctrl-hover)}
.legend-btn:active{transform:translateY(1px)}
.legend-item{display:inline-flex;align-items:center;gap:6px;cursor:pointer;user-select:none;color:var(--fg,#f5f5f5)}
.legend-item input{margin:0;cursor:pointer}
@media(max-width:900px){.mode-circle #header{align-items:stretch}.mode-circle #header-right{width:100%}#legendWrap{width:100%}}
.leaflet-popup-content-wrapper,.leaflet-popup-tip{opacity:var(--popup-opacity,1)}
.leaflet-popup-content-wrapper{font-size:11px;border-radius:5px}
.leaflet-popup-content{margin:5px 20px 5px 8px;line-height:1.4}
`;
	}

	/**
	 * Returns the shared JavaScript for all tracker maps.
	 * Reads TRACKER_CONFIG and TRACKER_DATA from the page.
	 *
	 * @returns {string} JavaScript IIFE string
	 */
	_sharedJs() {
		return `(function(){
"use strict";
var C=window.TRACKER_CONFIG||{};
var D=window.TRACKER_DATA||{};
var FEAT=D.features||[];
var TODAY=D.today||new Date().toISOString().slice(0,10);
var SEL=D.selDate||TODAY;
var KEY=D.personKey||'map';

var map=L.map('map');
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'\\u00a9 OpenStreetMap',maxZoom:19}).addTo(map);

var VIEW_KEY='tracker_view_'+KEY;
var _savedView=null;
try{_savedView=JSON.parse(sessionStorage.getItem(VIEW_KEY));}catch(e){}
if(_savedView){map.setView([_savedView.lat,_savedView.lng],_savedView.zoom);}
var _fitting=false;
map.on('moveend',function(){
  if(_fitting)return;
  var ctr=map.getCenter();
  sessionStorage.setItem(VIEW_KEY,JSON.stringify({lat:ctr.lat,lng:ctr.lng,zoom:map.getZoom()}));
  _savedView=JSON.parse(sessionStorage.getItem(VIEW_KEY));
});
function autoFit(b,o){if(_savedView)return;_fitting=true;map.fitBounds(b,o);setTimeout(function(){_fitting=false;},600);}
function autoView(ll,z){if(_savedView)return;_fitting=true;map.setView(ll,z);setTimeout(function(){_fitting=false;},600);}

var FitCtrl=L.Control.extend({onAdd:function(){
  var c=L.DomUtil.create('div','leaflet-bar leaflet-control');
  var a=L.DomUtil.create('a','',c);
  a.href='#';a.title='Auf Marker zoomen';
  a.style.cssText='display:flex;align-items:center;justify-content:center;text-decoration:none;color:#333;width:30px;height:30px;';
  a.innerHTML='<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"><path fill="currentColor" d="M12,8A4,4 0 0,1 16,12A4,4 0 0,1 12,16A4,4 0 0,1 8,12A4,4 0 0,1 12,8M3.05,13H1V11H3.05C3.5,6.83 6.83,3.5 11,3.05V1H13V3.05C17.17,3.5 20.5,6.83 20.95,11H23V13H20.95C20.5,17.17 17.17,20.5 13,20.95V23H11V20.95C6.83,20.5 3.5,17.17 3.05,13M12,5A7,7 0 0,0 5,12A7,7 0 0,0 12,19A7,7 0 0,0 19,12A7,7 0 0,0 12,5Z"/></svg>';
  L.DomEvent.on(a,'click',function(e){
    L.DomEvent.preventDefault(e);L.DomEvent.stopPropagation(e);
    sessionStorage.removeItem(VIEW_KEY);_savedView=null;
    var r=document.getElementById('menuRoute'),from=document.getElementById('dateFrom'),to=document.getElementById('dateTo');
    if(r&&r.checked){showRange(from.value,to.value);}else{showDay(to.value);}
  });
  return c;
}});
new FitCtrl({position:'topleft'}).addTo(map);

var layers=[];
var _routeGroups={};var _activeGroupKey=null;var _blockMapClick=false;
var ACTIVE_GROUP_KEY='tracker_active_group_'+KEY;
function _closeAllPopups(){layers.forEach(function(l){if(l.closePopup)l.closePopup();});}
function clearLayers(){layers.forEach(function(l){map.removeLayer(l);});layers=[];_routeGroups={};_activeGroupKey=null;}
var _linePopup=null;
function _resetHighlight(){
  _activeGroupKey=null;
  sessionStorage.removeItem(ACTIVE_GROUP_KEY);
  if(_linePopup){_linePopup.remove();_linePopup=null;}
  Object.keys(_routeGroups).forEach(function(k){
    var g=_routeGroups[k];
    if(g.polyline)g.polyline.setStyle({opacity:C.routeOpacity||0.85,weight:C.routeWeight||4});
    g.markers.forEach(function(m){
      m.closePopup();
      if(m.setStyle)m.setStyle(m._origStyle||{});
      else if(m.getElement)m.getElement().style.opacity='';
    });
  });
}
var _hoverActive=false;
function _applyGroupVisual(key,withPopups){
  Object.keys(_routeGroups).forEach(function(k){
    var g=_routeGroups[k];var isActive=(k===key);
    if(g.polyline){
      if(isActive)g.polyline.setStyle({opacity:C.routeOpacity||0.85,weight:(C.routeWeight||4)+2});
      else g.polyline.setStyle({opacity:0.15,weight:C.routeWeight||4});
    }
    g.markers.forEach(function(m){
      if(isActive){
        if(withPopups)m.openPopup();
        if(m.setStyle)m.setStyle(m._origStyle||{});
        else if(m.getElement)m.getElement().style.opacity='1';
      }else{
        if(withPopups)m.closePopup();
        if(m.setStyle)m.setStyle({fillOpacity:0.15,opacity:0.3,color:'rgba(255,255,255,0.3)'});
        else if(m.getElement)m.getElement().style.opacity='0.2';
      }
    });
  });
}
function _highlightGroup(key){
  if(_activeGroupKey===key){_resetHighlight();return;}
  _activeGroupKey=key;
  sessionStorage.setItem(ACTIVE_GROUP_KEY,key);
  if(_linePopup){_linePopup.remove();_linePopup=null;}
  _applyGroupVisual(key,true);
}
function _hoverOn(key,withPopups){
  var dh=document.getElementById('menuDayHighlight');
  if(!dh||!dh.checked||_activeGroupKey)return;
  _hoverActive=true;_applyGroupVisual(key,withPopups);
}
function _hoverOff(){
  if(!_hoverActive)return;
  _hoverActive=false;_resetHighlight();
}
map.on('click',function(){if(_blockMapClick){_blockMapClick=false;return;}if(_activeGroupKey){_resetHighlight();}else{_closeAllPopups();}});
function fmt(ts){if(!ts)return'\\u2013';return new Date(ts).toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'});}
function darken(hex,f){var r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);return'#'+[r,g,b].map(function(v){return Math.round(v*f).toString(16).padStart(2,'0');}).join('');}
function pinIcon(color){
  var w=Math.round(28*(C.markerSize||1)),h=Math.round(36*(C.markerSize||1));
  return L.divIcon({className:'',html:'<svg xmlns="http://www.w3.org/2000/svg" width="'+w+'" height="'+h+'" viewBox="0 0 28 36" style="opacity:'+(C.markerOpacity||1)+'"><path fill-rule="evenodd" d="M14 0C6.27 0 0 6.27 0 14c0 9.33 14 22 14 22S28 23.33 28 14C28 6.27 21.73 0 14 0z M8 14a6 6 0 1 0 12 0a6 6 0 1 0-12 0z" fill="'+color+'" stroke="#fff" stroke-width="1.5"/></svg>',iconSize:[w,h],iconAnchor:[Math.round(w/2),h],popupAnchor:[0,-h]});
}
function flagIcon(color,size,opacity){
  var w=Math.round(24*size),h=Math.round(24*size);
  return L.divIcon({className:'',html:'<svg xmlns="http://www.w3.org/2000/svg" width="'+w+'" height="'+h+'" viewBox="0 0 24 24" style="opacity:'+(opacity!=null?opacity:1)+'"><path paint-order="stroke fill" fill="'+color+'" stroke="#fff" stroke-width="1.5" stroke-linejoin="round" d="M14.4,6L14,4H5V21H7V14H12.6L13,16H20V6H14.4Z"/></svg>',iconSize:[w,h],iconAnchor:[0,h],popupAnchor:[Math.round(w/2),-h]});
}

var flagLayers=[],myFlagLayers=[];
function renderPlaceFlags(){
  flagLayers.forEach(function(l){map.removeLayer(l);});flagLayers=[];
  if(!C.showPlaces)return;
  var cb=document.getElementById('menuPlaces');if(!cb||!cb.checked)return;
  (D.placesData||[]).forEach(function(p){flagLayers.push(L.marker([p.lat,p.lng],{icon:flagIcon(C.placesColor,C.placesFlagSize,C.placesFlagOpacity)}).bindPopup('<b>'+p.name+'</b>').addTo(map));});
}
var placeRadiusLayers=[];
function renderPlaceRadii(){
  placeRadiusLayers.forEach(function(l){map.removeLayer(l);});placeRadiusLayers=[];
  if(!C.showPlaces)return;
  var cbf=document.getElementById('menuPlaces');if(!cbf||!cbf.checked)return;
  var cbr=document.getElementById('menuPlacesRadius');if(!cbr||!cbr.checked)return;
  (D.placesData||[]).forEach(function(p){if(p.radius>0){placeRadiusLayers.push(L.circle([p.lat,p.lng],{radius:p.radius,color:C.placesColor,fillColor:C.placesColor,fillOpacity:0.15,opacity:0.5,weight:1}).bindPopup('<b>'+p.name+'</b> ('+p.radius+' m)').addTo(map));}});
}
function renderMyPlaceFlags(){
  myFlagLayers.forEach(function(l){map.removeLayer(l);});myFlagLayers=[];
  if(!C.showMyPlaces)return;
  var cb=document.getElementById('menuMyPlaces');if(!cb||!cb.checked)return;
  (D.myPlacesData||[]).forEach(function(p){myFlagLayers.push(L.marker([p.lat,p.lng],{icon:flagIcon(C.myPlacesColor,C.myPlacesFlagSize,C.myPlacesFlagOpacity)}).bindPopup('<b>'+p.name+'</b>').addTo(map));});
}
var myPlaceRadiusLayers=[];
function renderMyPlaceRadii(){
  myPlaceRadiusLayers.forEach(function(l){map.removeLayer(l);});myPlaceRadiusLayers=[];
  if(!C.showMyPlaces)return;
  var cbf=document.getElementById('menuMyPlaces');if(!cbf||!cbf.checked)return;
  var cbr=document.getElementById('menuMyPlacesRadius');if(!cbr||!cbr.checked)return;
  (D.myPlacesData||[]).forEach(function(p){if(p.radius>0){myPlaceRadiusLayers.push(L.circle([p.lat,p.lng],{radius:p.radius,color:C.myPlacesColor,fillColor:C.myPlacesColor,fillOpacity:0.15,opacity:0.5,weight:1}).bindPopup('<b>'+p.name+'</b> ('+p.radius+' m)').addTo(map));}});
}

// ── Person map ───────────────────────────────────────────
function personShowDay(date){
  clearLayers();
  var feat=FEAT.find(function(f){return f.date===date;});
  if(!feat||!feat.coords.length)return;
  var color=feat.color||D.color||'#4a90e2';
  var dark=darken(color,0.6);
  var ts=feat.timestamps,coords=feat.coords;
  var showRoute=document.getElementById('menuRoute')&&document.getElementById('menuRoute').checked;
  if(showRoute){layers.push(L.polyline(coords,{color:color,weight:C.routeWeight||4,opacity:C.routeOpacity||0.85}).addTo(map));}
  if(showRoute&&coords.length>1){layers.push(L.circleMarker(coords[0],{radius:8,fillColor:dark,color:'#fff',weight:2,fillOpacity:1}).bindPopup('\\u25b6 Start: '+fmt(ts[0])).addTo(map));}
  layers.push(L.marker(coords[coords.length-1],{icon:pinIcon(color)}).bindPopup('\\uD83D\\uDCCD Last: '+fmt(ts[ts.length-1])).addTo(map));
  if(showRoute){coords.forEach(function(coord,i){if(i===0||i===coords.length-1)return;layers.push(L.circleMarker(coord,{radius:4,fillColor:color,color:'#fff',weight:1,fillOpacity:0.6}).bindPopup(fmt(ts[i])).addTo(map));});}
  var lbl=D.labels&&D.labels.lastPoint?D.labels.lastPoint:'Last';
  var hdr=document.getElementById('headerInfo');
  if(hdr)hdr.textContent=(showRoute&&coords.length>1?lbl+': '+fmt(ts[ts.length-1]):lbl+' ('+fmt(ts[ts.length-1])+')');
  if(showRoute&&coords.length>1){autoFit(L.latLngBounds(coords),{padding:[30,30]});}else{autoView(coords[coords.length-1],16);}
}
function personShowRange(from,to){
  clearLayers();
  var feats=FEAT.filter(function(f){return f.date>=from&&f.date<=to&&f.coords.length>0;});
  if(!feats.length)return;
  var maxDate=feats.reduce(function(m,f){return f.date>m?f.date:m;},'');
  var bounds=[];
  feats.forEach(function(feat){
    var fc=feat.color||D.color||'#4a90e2';var dark=darken(fc,0.6);var ts=feat.timestamps,coords=feat.coords;
    var grp={polyline:null,markers:[]};
    var pl=L.polyline(coords,{color:fc,weight:C.routeWeight||4,opacity:C.routeOpacity||0.85}).addTo(map);
    pl.bindTooltip(feat.date,{sticky:true,direction:'top',opacity:0.9});
    pl.on('mouseover',function(){var dh=document.getElementById('menuDayHighlight');if(!dh||!dh.checked||_activeGroupKey){pl.closeTooltip();return;}_hoverOn(feat.date,false);});
    pl.on('mouseout',function(){_hoverOff();});
    pl.on('click',function(e){pl.closeTooltip();_blockMapClick=true;_hoverActive=false;var dh=document.getElementById('menuDayHighlight');if(dh&&dh.checked){if(_activeGroupKey===feat.date){_resetHighlight();return;}_activeGroupKey=feat.date;sessionStorage.setItem(ACTIVE_GROUP_KEY,feat.date);if(_linePopup){_linePopup.remove();_linePopup=null;}_applyGroupVisual(feat.date,false);_linePopup=L.popup({autoClose:false,closeOnClick:false}).setLatLng(e.latlng).setContent(feat.date).openOn(map);}});
    grp.polyline=pl;layers.push(pl);
    bounds.push.apply(bounds,coords);
    var addM=function(m){
      m._origStyle={fillOpacity:m.options.fillOpacity||1,opacity:m.options.opacity!=null?m.options.opacity:1,color:m.options.color||'#fff'};
      m.on('click',function(){
        _blockMapClick=true;_hoverActive=false;
        var dh=document.getElementById('menuDayHighlight');
        if(dh&&dh.checked){_highlightGroup(feat.date);}
        else{if(_activeGroupKey)_resetHighlight();_closeAllPopups();m.openPopup();}
      });
      grp.markers.push(m);layers.push(m);
    };
    var sm=L.circleMarker(coords[0],{radius:7,fillColor:dark,color:'#fff',weight:2,fillOpacity:1}).bindPopup(feat.date+'<br>\\u25b6 '+fmt(ts[0]),{autoClose:false,closeOnClick:false}).addTo(map);addM(sm);
    var em;
    if(feat.date===maxDate){em=L.marker(coords[coords.length-1],{icon:pinIcon(fc)}).bindPopup(feat.date+'<br>\\uD83D\\uDCCD '+fmt(ts[ts.length-1]),{autoClose:false,closeOnClick:false}).addTo(map);}
    else{em=L.circleMarker(coords[coords.length-1],{radius:8,fillColor:fc,color:'#fff',weight:2,fillOpacity:C.markerOpacity||1}).bindPopup(feat.date+'<br>\\uD83D\\uDCCD '+fmt(ts[ts.length-1]),{autoClose:false,closeOnClick:false}).addTo(map);}
    addM(em);
    coords.forEach(function(coord,i){if(i===0||i===coords.length-1)return;var wm=L.circleMarker(coord,{radius:4,fillColor:fc,color:'#fff',weight:1,fillOpacity:0.6}).bindPopup(feat.date+'<br>'+fmt(ts[i]),{autoClose:false,closeOnClick:false}).addTo(map);addM(wm);});
    _routeGroups[feat.date]=grp;
  });
  if(bounds.length)autoFit(L.latLngBounds(bounds),{padding:[30,30]});
  location.hash=from+'_'+to;
}

// ── Circle map ───────────────────────────────────────────
var visiblePeople={};
(D.people||[]).forEach(function(p){visiblePeople[p.name]=localStorage.getItem('tracker_person_'+p.name+'_'+KEY)!=='false';});
function circleVisible(){return FEAT.filter(function(f){return visiblePeople[f.name]&&f.coords.length>0;});}
function circleRender(feats,withDate){
  clearLayers();if(!feats.length)return;
  var showRoute=document.getElementById('menuRoute')&&document.getElementById('menuRoute').checked;
  var bounds=[],maxByPerson={};
  feats.forEach(function(f){if(!maxByPerson[f.name]||f.date>maxByPerson[f.name])maxByPerson[f.name]=f.date;});
  feats.forEach(function(feat){
    var color=feat.color,dark=darken(color,0.6),coords=feat.coords,ts=feat.timestamps;
    var prefix=withDate?feat.date+'<br>':feat.name+'<br>';
    var grpKey=feat.name+'_'+feat.date;
    var grp={polyline:null,markers:[]};
    var addM=function(m){
      m._origStyle={fillOpacity:m.options.fillOpacity||1,opacity:m.options.opacity!=null?m.options.opacity:1,color:m.options.color||'#fff'};
      m.on('click',function(){
        _blockMapClick=true;_hoverActive=false;
        var dh=document.getElementById('menuDayHighlight');
        if(dh&&dh.checked){_highlightGroup(grpKey);}
        else{if(_activeGroupKey)_resetHighlight();_closeAllPopups();m.openPopup();}
      });
      grp.markers.push(m);layers.push(m);
    };
    if(showRoute){var pl=L.polyline(coords,{color:color,weight:C.routeWeight||4,opacity:C.routeOpacity||0.85}).addTo(map);pl.bindTooltip(feat.name+' - '+feat.date,{sticky:true,direction:'top',opacity:0.9});pl.on('mouseover',function(){var dh=document.getElementById('menuDayHighlight');if(!dh||!dh.checked||_activeGroupKey){pl.closeTooltip();return;}_hoverOn(grpKey,false);});pl.on('mouseout',function(){_hoverOff();});pl.on('click',function(e){pl.closeTooltip();_blockMapClick=true;_hoverActive=false;var dh=document.getElementById('menuDayHighlight');if(dh&&dh.checked){if(_activeGroupKey===grpKey){_resetHighlight();return;}_activeGroupKey=grpKey;sessionStorage.setItem(ACTIVE_GROUP_KEY,grpKey);if(_linePopup){_linePopup.remove();_linePopup=null;}_applyGroupVisual(grpKey,false);_linePopup=L.popup({autoClose:false,closeOnClick:false}).setLatLng(e.latlng).setContent(feat.name+'<br>'+feat.date).openOn(map);}});grp.polyline=pl;layers.push(pl);bounds.push.apply(bounds,coords);}
    if(showRoute&&coords.length>1){var sm=L.circleMarker(coords[0],{radius:7,fillColor:dark,color:'#fff',weight:2,fillOpacity:1}).bindPopup(prefix+'\\u25b6 '+fmt(ts[0]),{autoClose:false,closeOnClick:false}).addTo(map);addM(sm);}
    var em;
    if(feat.date===maxByPerson[feat.name]){em=L.marker(coords[coords.length-1],{icon:pinIcon(color)}).bindPopup(prefix+'\\uD83D\\uDCCD '+fmt(ts[ts.length-1]),{autoClose:false,closeOnClick:false}).addTo(map);}
    else{em=L.circleMarker(coords[coords.length-1],{radius:8,fillColor:color,color:'#fff',weight:2,fillOpacity:C.markerOpacity||1}).bindPopup(prefix+'\\uD83D\\uDCCD '+fmt(ts[ts.length-1]),{autoClose:false,closeOnClick:false}).addTo(map);}
    addM(em);
    if(showRoute){coords.forEach(function(coord,i){if(i===0||i===coords.length-1)return;var wm=L.circleMarker(coord,{radius:4,fillColor:color,color:'#fff',weight:1,fillOpacity:0.6}).bindPopup(prefix+fmt(ts[i]),{autoClose:false,closeOnClick:false}).addTo(map);addM(wm);});}
    _routeGroups[grpKey]=grp;
  });
  if(showRoute&&bounds.length){autoFit(L.latLngBounds(bounds),{padding:[30,30]});}
  else if(!showRoute&&feats.length){var pts=feats.map(function(f){return f.coords[f.coords.length-1];});if(pts.length===1){autoView(pts[0],16);}else{autoFit(L.latLngBounds(pts),{padding:[30,30]});}}
}
function circleShowDay(date){circleRender(circleVisible().filter(function(f){return f.date===date;}),false);}
function circleShowRange(from,to){circleRender(circleVisible().filter(function(f){return f.date>=from&&f.date<=to;}),true);location.hash=from+'_'+to;}

// ── Unified ──────────────────────────────────────────────
function showDay(date){if(D.mode==='circle'){circleShowDay(date);}else{personShowDay(date);}}
function showRange(from,to){if(D.mode==='circle'){circleShowRange(from,to);}else{personShowRange(from,to);}}

// ── Date inputs ──────────────────────────────────────────
var sortedDates=[...new Set(FEAT.map(function(f){return f.date;}))].sort();
var inpFrom=document.getElementById('dateFrom');
var inpTo=document.getElementById('dateTo');
if(inpFrom&&inpTo&&sortedDates.length){
  inpFrom.min=inpTo.min=sortedDates[0];
  inpFrom.max=inpTo.max=TODAY;
  function defaultFromDate(){
    var d=new Date();d.setDate(d.getDate()-((D.defaultDays||1)-1));
    return d.toISOString().slice(0,10);
  }
  var initFrom=defaultFromDate(),initTo=TODAY;
  if(location.hash){var parts=location.hash.slice(1).split('_');if(parts.length===2){initFrom=parts[0];initTo=parts[1];}}
  inpFrom.value=initFrom;inpTo.value=initTo;
  inpFrom.addEventListener('change',function(){if(inpFrom.value<=inpTo.value)showRange(inpFrom.value,inpTo.value);});
  inpTo.addEventListener('change',function(){if(inpFrom.value<=inpTo.value)showRange(inpFrom.value,inpTo.value);});
}

// ── Hamburger ────────────────────────────────────────────
var hamBtn=document.getElementById('hamBtn'),hamPanel=document.getElementById('hamPanel');
if(hamBtn&&hamPanel){
  hamBtn.addEventListener('click',function(e){
    e.stopPropagation();
    if(hamPanel.style.display==='block'){hamPanel.style.display='none';return;}
    hamPanel.style.left='';hamPanel.style.right='0';hamPanel.style.display='block';
    var rect=hamPanel.getBoundingClientRect();
    if(rect.left<4){hamPanel.style.right='';hamPanel.style.left='0';}
  });
  document.addEventListener('click',function(){hamPanel.style.display='none';});
  hamPanel.addEventListener('click',function(e){e.stopPropagation();});
}

// ── Route ────────────────────────────────────────────────
var menuRoute=document.getElementById('menuRoute');
if(menuRoute){
  var routeState=localStorage.getItem(D.storageKey||'tracker_showRoute');
  if(routeState===null)routeState='true';
  menuRoute.checked=routeState==='true';
  function applyRoute(show){
    if(D.mode==='circle'){
      var ef=document.getElementById('dateFrom'),et=document.getElementById('dateTo');
      var lf=document.getElementById('labelFrom'),lt=document.getElementById('labelTo');
      if(ef)ef.style.display=show?'':'none';if(et)et.style.display=show?'':'none';
      if(lf)lf.style.display=show?'':'none';if(lt)lt.style.display=show?'':'none';
    }else{
      var ef=document.getElementById('dateFrom'),et=document.getElementById('dateTo');
      var lf=document.getElementById('labelFrom'),lt=document.getElementById('labelTo');
      if(ef)ef.style.display=show?'':'none';if(et)et.style.display=show?'':'none';
      if(lf)lf.style.display=show?'':'none';if(lt)lt.style.display=show?'':'none';
      var hi=document.getElementById('headerInfo');
      if(hi)hi.style.display=show?'none':'';
    }
    var leg=document.getElementById('legend');if(leg)leg.style.display=show?'flex':'none';
  }
  if(!menuRoute.checked){applyRoute(false);if(inpTo)showDay(inpTo.value);}
  else{if(inpFrom&&inpTo)showRange(inpFrom.value,inpTo.value);}
  var _restoredGroup=sessionStorage.getItem(ACTIVE_GROUP_KEY);
  if(_restoredGroup&&_routeGroups[_restoredGroup]){_highlightGroup(_restoredGroup);}
  menuRoute.addEventListener('change',function(){
    localStorage.setItem(D.storageKey||'tracker_showRoute',this.checked?'true':'false');
    applyRoute(this.checked);
    if(this.checked){if(inpFrom&&inpTo)showRange(inpFrom.value,inpTo.value);}else{if(inpTo)showDay(inpTo.value);}
  });
}

// ── Footer ───────────────────────────────────────────────
var menuFooter=document.getElementById('menuFooter'),footerEl=document.getElementById('footer');
if(menuFooter&&footerEl){
  menuFooter.checked=localStorage.getItem('tracker_footer_'+KEY)!=='false';
  footerEl.style.display=menuFooter.checked?'flex':'none';
  menuFooter.addEventListener('change',function(){localStorage.setItem('tracker_footer_'+KEY,this.checked?'true':'false');footerEl.style.display=this.checked?'flex':'none';});
}

// ── Map size ─────────────────────────────────────────────
var menuMapSize=document.getElementById('menuMapSize'),mapSizeEl=document.getElementById('mapSizeLabel');
if(menuMapSize&&mapSizeEl){
  menuMapSize.checked=localStorage.getItem('tracker_mapsize_'+KEY)==='true';
  mapSizeEl.style.display=menuMapSize.checked?'':'none';
  menuMapSize.addEventListener('change',function(){localStorage.setItem('tracker_mapsize_'+KEY,this.checked?'true':'false');mapSizeEl.style.display=this.checked?'':'none';});
}

// ── Day highlight ─────────────────────────────────────────
var menuDayHighlight=document.getElementById('menuDayHighlight');if(menuDayHighlight){
  menuDayHighlight.checked=localStorage.getItem('tracker_dayhighlight_'+KEY)!=='false';
  menuDayHighlight.addEventListener('change',function(){
    localStorage.setItem('tracker_dayhighlight_'+KEY,this.checked?'true':'false');
    if(!this.checked){_hoverActive=false;_resetHighlight();}
  });
}

// ── Places ───────────────────────────────────────────────
if(C.showPlaces){
  var menuPlaces=document.getElementById('menuPlaces');
  if(menuPlaces){
    menuPlaces.checked=localStorage.getItem('tracker_places_'+KEY)!=='false';
    menuPlaces.addEventListener('change',function(){localStorage.setItem('tracker_places_'+KEY,this.checked?'true':'false');renderPlaceFlags();renderPlaceRadii();});
  }
  var menuPlacesRadius=document.getElementById('menuPlacesRadius');
  if(menuPlacesRadius){
    menuPlacesRadius.checked=localStorage.getItem('tracker_placesradius_'+KEY)!=='false';
    menuPlacesRadius.addEventListener('change',function(){localStorage.setItem('tracker_placesradius_'+KEY,this.checked?'true':'false');renderPlaceRadii();});
  }
}
if(C.showMyPlaces){
  var menuMyPlaces=document.getElementById('menuMyPlaces');
  if(menuMyPlaces){
    menuMyPlaces.checked=localStorage.getItem('tracker_myplaces_'+KEY)!=='false';
    menuMyPlaces.addEventListener('change',function(){localStorage.setItem('tracker_myplaces_'+KEY,this.checked?'true':'false');renderMyPlaceFlags();renderMyPlaceRadii();});
  }
  var menuMyPlacesRadius=document.getElementById('menuMyPlacesRadius');
  if(menuMyPlacesRadius){
    menuMyPlacesRadius.checked=localStorage.getItem('tracker_myplacesradius_'+KEY)!=='false';
    menuMyPlacesRadius.addEventListener('change',function(){localStorage.setItem('tracker_myplacesradius_'+KEY,this.checked?'true':'false');renderMyPlaceRadii();});
  }
}
renderPlaceFlags();renderPlaceRadii();renderMyPlaceFlags();renderMyPlaceRadii();

// ── Circle: person toggles ───────────────────────────────
if(D.mode==='circle'){
  document.querySelectorAll('.personToggle').forEach(function(cb){
    cb.checked=localStorage.getItem('tracker_person_'+cb.value+'_'+KEY)!=='false';
    cb.addEventListener('change',function(){
      visiblePeople[this.value]=this.checked;
      localStorage.setItem('tracker_person_'+this.value+'_'+KEY,this.checked?'true':'false');
      if(menuRoute&&menuRoute.checked){if(inpFrom&&inpTo)showRange(inpFrom.value,inpTo.value);}else{if(inpTo)showDay(inpTo.value);}
    });
  });
  var showAllBtn=document.getElementById('showAll'),hideAllBtn=document.getElementById('hideAll');
  function refreshCircle(){if(menuRoute&&menuRoute.checked){if(inpFrom&&inpTo)showRange(inpFrom.value,inpTo.value);}else{if(inpTo)showDay(inpTo.value);}}
  if(showAllBtn){showAllBtn.addEventListener('click',function(){document.querySelectorAll('.personToggle').forEach(function(cb){cb.checked=true;visiblePeople[cb.value]=true;localStorage.setItem('tracker_person_'+cb.value+'_'+KEY,'true');});refreshCircle();});}
  if(hideAllBtn){hideAllBtn.addEventListener('click',function(){document.querySelectorAll('.personToggle').forEach(function(cb){cb.checked=false;visiblePeople[cb.value]=false;localStorage.setItem('tracker_person_'+cb.value+'_'+KEY,'false');});refreshCircle();});}
}

// ── Auto-refresh ─────────────────────────────────────────
if(D.refresh){
  setTimeout(function(){var url=new URL(window.location.href);url.searchParams.set('_t',Date.now());window.location.replace(url.toString());},D.refresh*1000);
}

})();
`;
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

	// ─────────────────────────────────────────────
	// GEOJSON – FEATURECOLLECTION
	// ─────────────────────────────────────────────

	/**
	 * Returns an empty FeatureCollection
	 *
	 * @returns {{type:"FeatureCollection", features:Array}} Empty FeatureCollection with no features
	 */
	_emptyFeatureCollection() {
		return { type: "FeatureCollection", features: [] };
	}

	/**
	 * Clears all allTime GeoJSON recordings for every active person (or a subset) down to the single
	 * last known point and re-renders all affected maps.
	 * Called on adapter start when individual persons have clearRecordings=true in their config table.
	 * After clearing, _updateFamilyMap() is called if any cleared person has familyMap=true.
	 *
	 * @param {Array|null} [targetPeople] - Optional subset of person objects to clear. Defaults to all active persons.
	 * @returns {Promise<void>}
	 */
	async _clearAllRecordings(targetPeople = null) {
		const ns = this.config.namespace;
		const people = targetPeople ?? this.config.people.filter(p => p.enabled);
		let familyNeedsUpdate = false;

		for (const person of people) {
			const paths = this._getPaths(person.name);
			const existing = await this.adapter.getStateAsync(`${ns}.${paths.allTime}`);
			if (!existing?.val) {
				continue;
			}
			let fc;
			try {
				fc = JSON.parse(existing.val);
			} catch (e) {
				this.adapter.log.warn(`[Tracker:${person.name}] clearAllRecordings parse error: ${e.message}`);
				continue;
			}

			// Retain only the very last coordinate as a single seed point
			const lastFeature = fc.features[fc.features.length - 1];
			const newFC = this._emptyFeatureCollection();
			if (lastFeature?.geometry?.coordinates?.length > 0) {
				const lastCoord = lastFeature.geometry.coordinates[lastFeature.geometry.coordinates.length - 1];
				this._addPointToFC(newFC, lastCoord[0], lastCoord[1], lastCoord[2] || Date.now());
			}

			await this.adapter.setStateAsync(`${ns}.${paths.allTime}`, JSON.stringify(newFC), true);
			await this._writeMap(person, newFC);
			if (person.familyMap) {
				familyNeedsUpdate = true;
			}
			this.adapter.log.info(`[Tracker:${person.name}] All recordings cleared`);
		}

		if (familyNeedsUpdate) {
			await this._updateFamilyMap();
		}
		this.adapter.log.info("[Tracker] All recordings cleared successfully");
	}

	/**
	 * Iterates all active persons, loads their allTime GeoJSON, purges old features,
	 * and re-renders the map if any features were removed.
	 * Also updates the family map if at least one person belongs to it.
	 *
	 * @returns {Promise<void>}
	 */
	async _dailyPurgeAll() {
		if (!this.config.retentionDays || this.config.retentionDays <= 0) {
			return;
		}
		const ns = this.config.namespace;
		const activePeople = this.config.people.filter(p => p.enabled);
		let familyNeedsUpdate = false;

		for (const person of activePeople) {
			const paths = this._getPaths(person.name);
			const existing = await this.adapter.getStateAsync(`${ns}.${paths.allTime}`);
			if (!existing?.val) {
				continue;
			}
			let fc;
			try {
				fc = JSON.parse(existing.val);
			} catch (e) {
				this.adapter.log.warn(`[Tracker:${person.name}] dailyPurge parse error: ${e.message}`);
				continue;
			}
			const removed = this._purgeOldFeatures(fc, person.name);
			if (removed > 0) {
				await this.adapter.setStateAsync(`${ns}.${paths.allTime}`, JSON.stringify(fc), true);
				await this._writeMap(person, fc);
				if (person.familyMap) {
					familyNeedsUpdate = true;
				}
			}
		}

		if (familyNeedsUpdate) {
			await this._updateFamilyMap();
		}
	}

	/**
	 * Removes features older than retentionDays from a FeatureCollection (in-place).
	 * Does nothing if retentionDays is 0 or not set.
	 *
	 * @param {object} fc - FeatureCollection to purge
	 * @param {string} [label] - Label for log output (e.g. person name)
	 * @returns {number} Number of features removed
	 */
	_purgeOldFeatures(fc, label) {
		if (!this.config.retentionDays || this.config.retentionDays <= 0) {
			return 0;
		}
		const cutoff = new Date();
		cutoff.setDate(cutoff.getDate() - this.config.retentionDays);
		const cutoffStr = cutoff.toISOString().slice(0, 10);
		const before = fc.features.length;
		fc.features = fc.features.filter(f => f.properties.date >= cutoffStr);
		const removed = before - fc.features.length;
		if (removed > 0) {
			this.adapter.log.info(
				`[Tracker${label ? `:${label}` : ""}] Purged ${removed} day(s) older than ${cutoffStr} (retentionDays=${this.config.retentionDays})`,
			);
		}
		return removed;
	}

	/**
	 * Returns the feature for today's date, creating it if it does not exist
	 *
	 * @param {object} fc - FeatureCollection
	 * @returns {object} Existing or newly created Feature object for today's date
	 */
	_getTodayFeature(fc) {
		const today = new Date().toISOString().slice(0, 10);
		let feature = fc.features.find(f => f.properties.date === today);
		if (!feature) {
			feature = {
				type: "Feature",
				properties: {
					date: today,
					pointCount: 0,
					startTime: null,
					endTime: null,
				},
				geometry: { type: "LineString", coordinates: [] },
			};
			fc.features.push(feature);
		}
		return feature;
	}

	/**
	 * Adds a GPS point to today's feature inside the given FeatureCollection
	 *
	 * @param {object} fc - FeatureCollection (mutated in place)
	 * @param {number} lon
	 * @param {number} lat
	 * @param {number} ts - Timestamp in ms
	 */
	_addPointToFC(fc, lon, lat, ts) {
		const feature = this._getTodayFeature(fc);
		feature.geometry.coordinates.push([lon, lat, ts]);
		feature.properties.pointCount = feature.geometry.coordinates.length;
		if (!feature.properties.startTime) {
			feature.properties.startTime = ts;
		}
		feature.properties.endTime = ts;
	}

	/**
	 * Checks whether a new point should be stored (minimum distance to last point today)
	 *
	 * @param {object} fc - FeatureCollection (allTime)
	 * @param {number} lat
	 * @param {number} lon
	 * @param {number} [minDistance] - Effective minimum distance in meters; falls back to global config if omitted
	 * @returns {boolean} True if the minimum distance to the last point of today's feature is exceeded
	 */
	_shouldUpdate(fc, lat, lon, minDistance) {
		const today = new Date().toISOString().slice(0, 10);
		const feature = fc.features.find(f => f.properties.date === today);
		if (!feature || feature.geometry.coordinates.length === 0) {
			return true;
		}
		const last = feature.geometry.coordinates[feature.geometry.coordinates.length - 1];
		const effectiveMin = minDistance ?? this.config.minDistance;
		return this._getDistance(last[1], last[0], lat, lon) >= effectiveMin;
	}

	// ─────────────────────────────────────────────
	// HELPERS
	// ─────────────────────────────────────────────

	/**
	 * Returns state paths for a person or the family
	 *
	 * @param {string} name - Display name or family identifier
	 * @returns {{geojson:string, allTime:string, url:string, filePath:string}} Object with relative state paths and HTML file path
	 */
	_getPaths(name) {
		const now = new Date();
		const month = String(now.getMonth() + 1).padStart(2, "0");
		const safe = name.toLowerCase().replace(/\s+/g, "_");
		const base = `tracker.${safe}.currentYear.${month}`;
		return {
			geojson: `${base}.geojson`,
			allTime: `tracker.${safe}.allTime.geojson`,
			url: `tracker.${safe}.url`,
			urlLocal: `tracker.${safe}.urlLocal`,
			filePath: `tracker/${safe}.html`,
		};
	}

	/**
	 * Builds the map URL for a person
	 *
	 * @param {{name:string}} person
	 * @returns {string} Full HTTP URL to the person's HTML map file
	 */
	_buildUrl(person) {
		const safe = person.name.toLowerCase().replace(/\s+/g, "_");
		return `/${this.config.namespace}/tracker/${safe}.html`;
	}

	/**
	 * Builds the URL for the family map
	 *
	 * @returns {string} Full HTTP URL to the family HTML map file
	 */
	_buildFamilyUrl() {
		return `/${this.config.namespace}/tracker/${this.config.familyName}.html`;
	}

	/**
	 * Returns the first external IPv4 address found, or 127.0.0.1 as fallback
	 *
	 * @returns {string} First non-internal IPv4 address found, or 127.0.0.1 as fallback
	 */
	_getLocalIP() {
		try {
			const os = require("node:os");
			const nets = os.networkInterfaces();
			for (const ifaces of Object.values(nets)) {
				for (const iface of ifaces) {
					if (iface.family === "IPv4" && !iface.internal) {
						return iface.address;
					}
				}
			}
		} catch (e) {
			this.adapter.log.warn(`[Tracker] Failed to determine IP address: ${e.message}`);
		}
		return "127.0.0.1";
	}

	/**
	 * Resolves the web adapter port and protocol once at startup.
	 * Falls back to port 8082 / http if not determinable.
	 *
	 * @returns {Promise<void>}
	 */
	async _resolveWebAccess() {
		try {
			const webObj = await this.adapter.getForeignObjectAsync("system.adapter.web.0");
			this._webPort = webObj?.native?.port ?? 8082;
			this._webSecure = webObj?.native?.secure ?? false;
			this.adapter.log.debug(
				`[Tracker] Web adapter: ${this._webSecure ? "https" : "http"}://<host>:${this._webPort}`,
			);
		} catch (e) {
			this.adapter.log.warn(`[Tracker] Could not resolve web adapter port, using 8082: ${e.message}`);
		}
	}

	/**
	 * Builds a fully qualified local URL for a given relative path.
	 *
	 * @param {string} relativePath - Relative path starting with "/"
	 * @returns {string} Full URL, e.g. http://192.168.1.10:8082/life360ng.0/tracker/name.html
	 */
	_buildLocalUrl(relativePath) {
		const protocol = this._webSecure ? "https" : "http";
		return `${protocol}://${this._getLocalIP()}:${this._webPort}${relativePath}`;
	}

	/**
	 * Resolves the UUID of a person from the object tree (cached)
	 *
	 * @param {string} name - Display name of the person
	 * @returns {Promise<string>} UUID segment of the person (part after .people. in the ioBroker object ID)
	 */
	async _resolvePersonId(name) {
		if (this._personIdCache[name]) {
			return this._personIdCache[name];
		}

		const objects = await this.adapter.getObjectViewAsync("system", "channel", {
			startkey: `${this.config.namespace}.people.`,
			endkey: `${this.config.namespace}.people.\u9999`,
		});

		for (const row of objects.rows) {
			if (row.value?.common?.name === name) {
				const id = row.id.split(".people.")[1];
				this._personIdCache[name] = id;
				return id;
			}
		}

		this.adapter.log.warn(`[Tracker] Person not found: ${name}`);
		return name.toLowerCase();
	}

	/**
	 * Calculates the distance between two GPS coordinates using the Haversine formula
	 *
	 * @param {number} lat1
	 * @param {number} lon1
	 * @param {number} lat2
	 * @param {number} lon2
	 * @returns {number} Distance in meters
	 */
	_getDistance(lat1, lon1, lat2, lon2) {
		const R = 6371e3;
		const p1 = (lat1 * Math.PI) / 180;
		const p2 = (lat2 * Math.PI) / 180;
		const dp = ((lat2 - lat1) * Math.PI) / 180;
		const dl = ((lon2 - lon1) * Math.PI) / 180;
		const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
		return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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
		const yiq = (r * 299 + g * 587 + b * 114) / 1000;
		return yiq >= 160 ? "#111111" : "#f5f5f5";
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

	/**
	 * Creates a state if it does not exist and sets its value
	 *
	 * @param {string} id - Relative state ID (without namespace)
	 * @param {string|number|boolean} value - Value to set
	 * @param {object} meta - Common object for the state
	 * @returns {Promise<void>} Resolved after the state has been created if needed and updated with the provided value
	 */
	async _ensureState(id, value, meta) {
		const fullId = `${this.config.namespace}.${id}`;
		const obj = await this.adapter.getObjectAsync(fullId);
		if (!obj) {
			await this.adapter.setObjectAsync(fullId, {
				type: "state",
				common: { ...meta, def: value },
				native: {},
			});
		}
		await this.adapter.setStateAsync(fullId, value, true);
	}
}

module.exports = Tracker;
