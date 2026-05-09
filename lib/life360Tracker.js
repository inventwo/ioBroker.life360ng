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
		places: "Places",
		myPlaces: "My Places",
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
		places: "Orte",
		myPlaces: "Eigene Orte",
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
				showPlaces: c.tracker_show_places ?? false,
				placesColor: c.tracker_places_color || "#db8158",
				placesFlagSize: c.tracker_places_flag_size ?? 1.0,
				showMyPlaces: c.tracker_show_myplaces ?? false,
				myPlacesColor: c.tracker_myplaces_color || "#996a53",
				myPlacesFlagSize: c.tracker_myplaces_flag_size ?? 1.0,
			},
			familyRoutesEnabled: c.tracker_family_routes_enabled ?? true,
			familyMapHeaderName: c.family_map_header_name || "",
			retentionDays: c.tracker_retention_days ?? 0,
		};
	}

	/**
	 * Defines all tracker.config.* states with their metadata and default values.
	 * Default value = current this.config value (set by _loadConfig from adapter.config).
	 *
	 * @returns {Array<{id:string, value:any, meta:object}>} Gibt ein Array mit Konfigurations-State-Definitionen zurück.
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
	 * @param {any} val - New value
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
		if (!this._shouldUpdate(allTimeFC, lat, long)) {
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
					.map(p => ({ name: String(p.name || ""), lat: Number(p.latitude), lng: Number(p.longitude) }))
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
						places.push({ name, lat, lng });
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

		// Only include route data if includeRoute is true
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
				// Only include the last point for each day
				const lastCoord = f.geometry.coordinates[f.geometry.coordinates.length - 1];
				return {
					date: f.properties.date,
					coords: lastCoord ? [[lastCoord[1], lastCoord[0]]] : [],
					timestamps: lastCoord ? [lastCoord[2] || null] : [],
					color: f.properties.color || color,
				};
			}),
		);
		// Build a unique key for localStorage per person
		const personKey = person.id ? String(person.id) : person.name.replace(/[^a-zA-Z0-9]/g, "_");

		// Calculate headerFg, controlBg, controlBorder, etc. like in family map
		const headerFg = this._getContrastText(c.headerBg);
		const controlBg = this._scaleColor(c.headerBg, 0.82);
		const controlBorder = this._scaleColor(c.headerBg, 0.62);
		const controlHoverBg = this._scaleColor(c.headerBg, 0.72);

		return (
			`<!DOCTYPE html>
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
	#hamBtn { background:none; border:1px solid ${controlBorder}; border-radius:4px; color:${headerFg}; font-size:18px; line-height:1; padding:2px 8px; cursor:pointer; margin-left:10px; }
	#hamBtn:hover { background:${controlHoverBg}; }
	#hamMenu { position:relative; }
	#hamPanel { display:none; position:absolute; right:0; top:calc(100% + 4px); background:${c.headerBg}; border:1px solid ${controlBorder}; border-radius:6px; padding:8px 12px; z-index:2000; min-width:170px; box-shadow:0 4px 12px rgba(0,0,0,0.4); }
	#hamPanel label { display:flex; align-items:center; gap:8px; cursor:pointer; user-select:none; color:${headerFg}; font-size:13px; padding:4px 0; white-space:nowrap; }
	#hamPanel input[type="checkbox"] { margin:0; cursor:pointer; }
	#map { flex:1; }
	#footer { color:${headerFg}; padding:5px 14px; background:${c.headerBg}; display:flex; align-items:center; gap:20px; font-size:12px; border-top:1px solid ${c.headerBorder}; flex-wrap:wrap; min-height:30px; }
	#footer .leg-entry { display:inline-flex; align-items:center; gap:6px; }
</style>
</head>
<body>
<div id="header">
	<h2>📍 ${firstName}</h2>
	<div id="header-right">
		<span id="headerInfo"></span>
		<span class="range-label" id="labelFrom">${this._t("from")}</span>
		<input type="date" id="dateFrom">
		<span class="range-label" id="labelTo">${this._t("to")}</span>
		<input type="date" id="dateTo">
	</div>
	<div id="hamMenu">
		<button type="button" id="hamBtn">&#9776;</button>
		<div id="hamPanel">
			<label><input type="checkbox" id="menuRoute"> ${this._t("route")}</label>
${c.showPlaces ? `			<label><input type="checkbox" id="menuPlaces" style="accent-color:${c.placesColor}"> ${this._t("places")}</label>` : ""}
${c.showMyPlaces ? `			<label><input type="checkbox" id="menuMyPlaces" style="accent-color:${c.myPlacesColor}"> ${this._t("myPlaces")}</label>` : ""}
			<label><input type="checkbox" id="menuFooter"> Footer</label>
			<label><input type="checkbox" id="menuMapSize"> ${this._t("mapSize")}</label>
		</div>
	</div>
</div>
<div id="map"></div>
<div id="footer">
  <div id="legend" style="display:flex;align-items:center;gap:20px;flex-wrap:wrap">
  <span class="leg-entry">
    <svg class="leg-svg" width="16" height="16" viewBox="0 0 16 16">
      <circle cx="8" cy="8" r="6" fill="#000000" stroke="#ffffff" stroke-width="1.5" opacity="0.7"/>
    </svg>
    ${this._t("origin")}
  </span>
  <span class="leg-entry">
    <svg class="leg-svg" width="16" height="16" viewBox="0 0 16 16">
      <circle cx="8" cy="8" r="5" fill="#888888" stroke="#ffffff" stroke-width="1.5" opacity="0.7"/>
    </svg>
    ${this._t("stopover")}
  </span>
  <span class="leg-entry">
    <svg class="leg-svg" width="14" height="18" viewBox="0 0 14 18">
      <path fill-rule="evenodd" d="M7 0C3.13 0 0 3.13 0 7c0 5.25 7 11 7 11s7-5.75 7-11c0-3.87-3.13-7-7-7z M4 7a3 3 0 1 0 6 0 3 3 0 0 0-6 0z" fill="${headerFg}" stroke="#ffffff" stroke-width="0.8"/>
    </svg>
    ${this._t("currentPosition")}
  </span>
  </div>
  <span id="mapSizeLabel" style="margin-left:auto;display:none">${this._t("mapSize")}: __MAPSIZE__</span>
</div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></` +
			`script>
<script>
	const FEATURES        = ${featuresJSON};
	const COLOR           = "${color}";
	const DARK            = "${dark}";
	const SEL_DATE        = "${selDate}";
	const MARKER_OPACITY  = ${c.markerOpacity};
	const MARKER_SIZE     = ${c.markerSize};
	const LAST_POINT      = "${this._t("lastPoint")}";
	// Use a unique storage key per person (personId or name)
	const STORAGE_KEY = "tracker_showRoute_${personKey}";
	const PLACES_DATA = ${JSON.stringify(this._placesCache.life360)};
	const MYPLACES_DATA = ${JSON.stringify(this._placesCache.myPlaces)};
	const SHOW_PLACES = ${c.showPlaces ? "true" : "false"};
	const SHOW_MYPLACES = ${c.showMyPlaces ? "true" : "false"};
	const PLACES_COLOR = "${c.placesColor}";
	const MYPLACES_COLOR = "${c.myPlacesColor}";
	const PLACES_FLAG_SIZE = ${c.placesFlagSize};
	const MYPLACES_FLAG_SIZE = ${c.myPlacesFlagSize};
	const PLACES_STORAGE_KEY = "tracker_places_${personKey}";
	const MYPLACES_STORAGE_KEY = "tracker_myplaces_${personKey}";

  const map = L.map('map');
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap', maxZoom: 19
  }).addTo(map);

  let layers = [];

	/**
	 * Removes all layers from the map.
	 * @returns {void} Nothing.
	 */
	function clearLayers() { layers.forEach(l => map.removeLayer(l)); layers = []; }

	/**
	 * Formats a timestamp as time string.
	 * @param {number|string} ts
	 * @returns {string} Formatted time or dash.
	 */
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
function flagIcon(color, size) {
var w = Math.round(24 * size);
var h = Math.round(24 * size);
return L.divIcon({
className: '',
html: '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 24 24"><path paint-order="stroke fill" fill="' + color + '" stroke="#fff" stroke-width="1.5" stroke-linejoin="round" d="M14.4,6L14,4H5V21H7V14H12.6L13,16H20V6H14.4Z"/></svg>',
iconSize: [w, h],
iconAnchor: [0, h],
popupAnchor: [Math.round(w / 2), -h]
});
}
var flagLayers = [];
var myFlagLayers = [];
function renderPlaceFlags() {
flagLayers.forEach(function(l) { map.removeLayer(l); }); flagLayers = [];
if (!SHOW_PLACES) return;
var cb = document.getElementById('showPlaces');
if (!cb || !cb.checked) return;
PLACES_DATA.forEach(function(p) {
flagLayers.push(L.marker([p.lat, p.lng], { icon: flagIcon(PLACES_COLOR, PLACES_FLAG_SIZE) }).bindPopup('<b>' + p.name + '</b>').addTo(map));
});
}
function renderMyPlaceFlags() {
myFlagLayers.forEach(function(l) { map.removeLayer(l); }); myFlagLayers = [];
if (!SHOW_MYPLACES) return;
var cb = document.getElementById('showMyPlaces');
if (!cb || !cb.checked) return;
MYPLACES_DATA.forEach(function(p) {
myFlagLayers.push(L.marker([p.lat, p.lng], { icon: flagIcon(MYPLACES_COLOR, MYPLACES_FLAG_SIZE) }).bindPopup('<b>' + p.name + '</b>').addTo(map));
});
}
	function showDay(date) {
		clearLayers();
		const feat = FEATURES.find(f => f.date === date);
		if (!feat || feat.coords.length === 0) return;

		const c      = feat.color || COLOR;
		const ts     = feat.timestamps;
		const coords = feat.coords;

		const showRoute = document.getElementById('showRoute')?.checked;

		if (showRoute) {
			const line = L.polyline(coords, { color:c, weight:${c.routeWeight}, opacity:${c.routeOpacity} }).addTo(map);
			layers.push(line);
		}

		// Startpunkt nur anzeigen, wenn Route sichtbar
		if (showRoute && coords.length > 1) {
			layers.push(
				L.circleMarker(coords[0], { radius:8, fillColor:DARK, color:'#fff', weight:2, fillOpacity:1 })
					.bindPopup('▶ Start: ' + fmt(ts[0])).addTo(map)
			);
		}
		// Letzter Punkt immer anzeigen
		layers.push(
			L.marker(coords[coords.length-1], { icon: pinIcon(c) })
				.bindPopup('📍 Last: ' + fmt(ts[ts.length-1])).addTo(map)
		);

		// Nur Zwischenpunkte anzeigen, wenn Route sichtbar
		if (showRoute) {
			coords.forEach(function(coord, i) {
				if (i === 0 || i === coords.length - 1) return;
				layers.push(
					L.circleMarker(coord, { radius:4, fillColor:c, color:'#fff', weight:1, fillOpacity:0.6 })
						.bindPopup(fmt(ts[i])).addTo(map)
				);
			});
		}

		// Zoom auf Route oder letzten Punkt
		if (showRoute && coords.length > 1) {
			map.fitBounds(L.latLngBounds(coords), { padding:[30,30] });
		} else {
			map.setView(coords[coords.length-1], 16);
		}
		document.getElementById('headerInfo').textContent =
			(showRoute && coords.length > 1
				? LAST_POINT + ': ' + fmt(ts[ts.length-1])
				: LAST_POINT + ' (' + fmt(ts[ts.length-1]) + ')');
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

	// Hamburger menu
	var hamBtn = document.getElementById('hamBtn');
	var hamPanel = document.getElementById('hamPanel');
	hamBtn.addEventListener('click', function(e) { e.stopPropagation(); hamPanel.style.display = hamPanel.style.display === 'none' ? 'block' : 'none'; });
	document.addEventListener('click', function() { hamPanel.style.display = 'none'; });
	hamPanel.addEventListener('click', function(e) { e.stopPropagation(); });

	// Route
	var menuRoute = document.getElementById('menuRoute');
	var routeState = localStorage.getItem(STORAGE_KEY);
	if (routeState === null) routeState = 'true';
	menuRoute.checked = routeState === 'true';
	function applyRoute(show) {
		document.getElementById('dateFrom').style.display = show ? '' : 'none';
		document.getElementById('dateTo').style.display = show ? '' : 'none';
		document.getElementById('labelFrom').style.display = show ? '' : 'none';
		document.getElementById('labelTo').style.display = show ? '' : 'none';
		var leg = document.getElementById('legend'); if (leg) leg.style.display = show ? 'flex' : 'none';
	}
	if (!menuRoute.checked) {
		applyRoute(false);
		showDay(inpTo.value);
	} else {
		showRange(initFrom, initTo);
	}
	menuRoute.addEventListener('change', function() {
		localStorage.setItem(STORAGE_KEY, this.checked ? 'true' : 'false');
		applyRoute(this.checked);
		if (this.checked) { showRange(inpFrom.value, inpTo.value); } else { showDay(inpTo.value); }
	});

	// Footer
	var menuFooter = document.getElementById('menuFooter');
	var footerState = localStorage.getItem('tracker_footer_${personKey}');
	menuFooter.checked = footerState !== 'false';
	document.getElementById('footer').style.display = menuFooter.checked ? 'flex' : 'none';
	menuFooter.addEventListener('change', function() {
		localStorage.setItem('tracker_footer_${personKey}', this.checked ? 'true' : 'false');
		document.getElementById('footer').style.display = this.checked ? 'flex' : 'none';
	});

	// Map size
	var menuMapSize = document.getElementById('menuMapSize');
	var mapSizeState = localStorage.getItem('tracker_mapsize_${personKey}');
	menuMapSize.checked = mapSizeState === 'true';
	var mapSizeEl = document.getElementById('mapSizeLabel');
	if (mapSizeEl) mapSizeEl.style.display = menuMapSize.checked ? '' : 'none';
	menuMapSize.addEventListener('change', function() {
		localStorage.setItem('tracker_mapsize_${personKey}', this.checked ? 'true' : 'false');
		if (mapSizeEl) mapSizeEl.style.display = this.checked ? '' : 'none';
	});

	// Places
	if (SHOW_PLACES) {
		var menuPlaces = document.getElementById('menuPlaces');
		menuPlaces.checked = localStorage.getItem(PLACES_STORAGE_KEY) !== 'false';
		menuPlaces.addEventListener('change', function() {
			localStorage.setItem(PLACES_STORAGE_KEY, this.checked ? 'true' : 'false');
			renderPlaceFlags();
		});
	}
	if (SHOW_MYPLACES) {
		var menuMyPlaces = document.getElementById('menuMyPlaces');
		menuMyPlaces.checked = localStorage.getItem(MYPLACES_STORAGE_KEY) !== 'false';
		menuMyPlaces.addEventListener('change', function() {
			localStorage.setItem(MYPLACES_STORAGE_KEY, this.checked ? 'true' : 'false');
			renderMyPlaceFlags();
		});
	}
	renderPlaceFlags();
	renderMyPlaceFlags();
  setTimeout(function() {
    const url = new URL(window.location.href);
    url.searchParams.set('_t', Date.now());
    window.location.replace(url.toString());
  }, ${refresh} * 1000);
</` +
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

		// Nur Vornamen für Legende/Checkboxen
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

		return (
			`<!DOCTYPE html>
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
  #legendItems { color:${subText}; font-size:12px; display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
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

  #hamBtn { background:none; border:1px solid ${controlBorder}; border-radius:4px; color:${headerFg}; font-size:18px; line-height:1; padding:2px 8px; cursor:pointer; margin-left:10px; }
  #hamBtn:hover { background:${controlHoverBg}; }
  #hamMenu { position:relative; }
  #hamPanel { display:none; position:absolute; right:0; top:calc(100% + 4px); background:${c.headerBg}; border:1px solid ${controlBorder}; border-radius:6px; padding:8px 12px; z-index:2000; min-width:170px; box-shadow:0 4px 12px rgba(0,0,0,0.4); }
  #hamPanel label { display:flex; align-items:center; gap:8px; cursor:pointer; user-select:none; color:${headerFg}; font-size:13px; padding:4px 0; white-space:nowrap; }
  #hamPanel input[type="checkbox"] { margin:0; cursor:pointer; }

  #map { flex:1; }
  #footer {color:${headerFg}; padding:5px 14px; background:${c.headerBg}; display:flex; align-items:center; gap:20px; font-size:12px; border-top:1px solid ${c.headerBorder}; flex-wrap:wrap; min-height:30px; }
  #footer .leg-entry { display:inline-flex; align-items:center; gap:6px; }

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
				<button type="button" id="showAll" class="legend-btn">${this._t("allOn")}</button>
				<button type="button" id="hideAll" class="legend-btn">${this._t("allOff")}</button>
			</div>
			<div id="legendItems">${legendItems}</div>
		</div>
		<span class="range-label" id="labelFrom">${this._t("from")}</span>
		<input type="date" id="dateFrom">
		<span class="range-label" id="labelTo">${this._t("to")}</span>
		<input type="date" id="dateTo">
	</div>
	<div id="hamMenu">
		<button type="button" id="hamBtn">&#9776;</button>
		<div id="hamPanel">
			<label><input type="checkbox" id="menuRoute"> ${this._t("route")}</label>
${c.showPlaces ? `			<label><input type="checkbox" id="menuPlaces" style="accent-color:${c.placesColor}"> ${this._t("places")}</label>` : ""}
${c.showMyPlaces ? `			<label><input type="checkbox" id="menuMyPlaces" style="accent-color:${c.myPlacesColor}"> ${this._t("myPlaces")}</label>` : ""}
			<label><input type="checkbox" id="menuFooter"> Footer</label>
			<label><input type="checkbox" id="menuMapSize"> ${this._t("mapSize")}</label>
		</div>
	</div>
</div>
<div id="map"></div>
<div id="footer">
  <div id="legend" style="display:flex;align-items:center;gap:20px;flex-wrap:wrap">
  <span class="leg-entry">
    <svg class="leg-svg" width="16" height="16" viewBox="0 0 16 16">
      <circle cx="8" cy="8" r="6" fill="#000000" stroke="#ffffff" stroke-width="1.5" opacity="0.7"/>
    </svg>
    ${this._t("origin")}
  </span>
  <span class="leg-entry">
    <svg class="leg-svg" width="16" height="16" viewBox="0 0 16 16">
      <circle cx="8" cy="8" r="5" fill="#888888" stroke="#ffffff" stroke-width="1.5" opacity="0.7"/>
    </svg>
    ${this._t("stopover")}
  </span>
  <span class="leg-entry">
    <svg class="leg-svg" width="14" height="18" viewBox="0 0 14 18">
      <path fill-rule="evenodd" d="M7 0C3.13 0 0 3.13 0 7c0 5.25 7 11 7 11s7-5.75 7-11c0-3.87-3.13-7-7-7z M4 7a3 3 0 1 0 6 0 3 3 0 0 0-6 0z" fill="${headerFg}" stroke="#ffffff" stroke-width="0.8"/>
    </svg>
    ${this._t("currentPosition")}
  </span>
  </div>
  <span id="mapSizeLabel" style="margin-left:auto;display:none">${this._t("mapSize")}: __MAPSIZE__</span>
</div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></` +
			`script>
<script>
  const FEATURES       = ${featuresJSON};
  const SEL_DATE       = "${selDate}";
  const MARKER_OPACITY = ${c.markerOpacity};
  const MARKER_SIZE     = ${c.markerSize};
	const visiblePeople = Object.fromEntries([...new Set(FEATURES.map(f => f.name))].map(name => [name, true]));
	// Use a unique storage key for the family map
	const STORAGE_KEY = "tracker_showRoute_circle";
	const PLACES_DATA = ${JSON.stringify(this._placesCache.life360)};
	const MYPLACES_DATA = ${JSON.stringify(this._placesCache.myPlaces)};
	const SHOW_PLACES = ${c.showPlaces ? "true" : "false"};
	const SHOW_MYPLACES = ${c.showMyPlaces ? "true" : "false"};
	const PLACES_COLOR = "${c.placesColor}";
	const MYPLACES_COLOR = "${c.myPlacesColor}";
	const PLACES_FLAG_SIZE = ${c.placesFlagSize};
	const MYPLACES_FLAG_SIZE = ${c.myPlacesFlagSize};
	const PLACES_STORAGE_KEY = "tracker_places_circle";
	const MYPLACES_STORAGE_KEY = "tracker_myplaces_circle";

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
function flagIcon(color, size) {
var w = Math.round(24 * size);
var h = Math.round(24 * size);
return L.divIcon({
className: '',
html: '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 24 24"><path paint-order="stroke fill" fill="' + color + '" stroke="#fff" stroke-width="1.5" stroke-linejoin="round" d="M14.4,6L14,4H5V21H7V14H12.6L13,16H20V6H14.4Z"/></svg>',
iconSize: [w, h],
iconAnchor: [0, h],
popupAnchor: [Math.round(w / 2), -h]
});
}
var flagLayers = [];
var myFlagLayers = [];
function renderPlaceFlags() {
flagLayers.forEach(function(l) { map.removeLayer(l); }); flagLayers = [];
if (!SHOW_PLACES) return;
var cb = document.getElementById('showPlaces');
if (!cb || !cb.checked) return;
PLACES_DATA.forEach(function(p) {
flagLayers.push(L.marker([p.lat, p.lng], { icon: flagIcon(PLACES_COLOR, PLACES_FLAG_SIZE) }).bindPopup('<b>' + p.name + '</b>').addTo(map));
});
}
function renderMyPlaceFlags() {
myFlagLayers.forEach(function(l) { map.removeLayer(l); }); myFlagLayers = [];
if (!SHOW_MYPLACES) return;
var cb = document.getElementById('showMyPlaces');
if (!cb || !cb.checked) return;
MYPLACES_DATA.forEach(function(p) {
myFlagLayers.push(L.marker([p.lat, p.lng], { icon: flagIcon(MYPLACES_COLOR, MYPLACES_FLAG_SIZE) }).bindPopup('<b>' + p.name + '</b>').addTo(map));
});
}
	/**
	 * Darkens a hex color.
	 * @param {string} hex
	 * @param {number} f
	 * @returns {string} New hex color.
	 */
	function darken(hex, f) {
		const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
		return '#' + [r,g,b].map(v => Math.round(v*f).toString(16).padStart(2,'0')).join('');
	}

	/**
	 * Returns all visible features.
	 * @returns {Array} Array of visible features.
	 */
	function getVisibleFeatures() {
		return FEATURES.filter(f => visiblePeople[f.name] && f.coords.length > 0);
	}

	function renderFeatures(feats, withDateOnly) {
		clearLayers();
		if (feats.length === 0) return;

		// Only render routes if showRoute is enabled
		const showRoute = document.getElementById('showRoute')?.checked;
		const bounds = [];
		// Most recent date per person: only that day gets a pin, all others get a larger dot
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

			// Start marker only if route is visible and more than 1 point
			if (showRoute && coords.length > 1) {
				layers.push(
					L.circleMarker(coords[0], { radius:7, fillColor:dark, color:'#fff', weight:2, fillOpacity:1 })
						.bindPopup(prefix + '▶ Start: ' + fmt(ts[0])).addTo(map)
				);
			}
			// Most recent day → pin, past days → larger dot
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

			// Only show intermediate points if route is visible
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
			// Zoom to all last points if route is hidden
			const lastPoints = feats.map(f => f.coords[f.coords.length - 1]);
			if (lastPoints.length === 1) {
				map.setView(lastPoints[0], 16);
			} else {
				map.fitBounds(L.latLngBounds(lastPoints), { padding:[30,30] });
			}
		}
	}

  function showDay(date) {
    const dayFeats = getVisibleFeatures().filter(f => f.date === date);
    renderFeatures(dayFeats, false);
  }

  function showRange(from, to) {
    const feats = getVisibleFeatures().filter(f => f.date >= from && f.date <= to);
    renderFeatures(feats, true);
    location.hash = from + '_' + to;
  }

  const sortedDates = [...new Set(FEATURES.map(f => f.date))].sort();
  const inpFrom = document.getElementById('dateFrom');
  const inpTo = document.getElementById('dateTo');
  inpFrom.min = inpTo.min = sortedDates[0];
  inpFrom.max = inpTo.max = "${today}";

  let initFrom = "${selDate}", initTo = "${today}";
  if (location.hash) {
    const parts = location.hash.slice(1).split('_');
    if (parts.length === 2) {
      initFrom = parts[0];
      initTo = parts[1];
    }
  }
  inpFrom.value = initFrom;
  inpTo.value = initTo;

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
    document.querySelectorAll('.personToggle').forEach(cb => {
      cb.checked = true;
      visiblePeople[cb.value] = true;
    });
    refreshCurrentView();
  });

  document.getElementById('hideAll').addEventListener('click', function() {
    document.querySelectorAll('.personToggle').forEach(cb => {
      cb.checked = false;
      visiblePeople[cb.value] = false;
    });
    refreshCurrentView();
  });

  inpFrom.addEventListener('change', function() {
    if (inpFrom.value <= inpTo.value) showRange(inpFrom.value, inpTo.value);
  });
  inpTo.addEventListener('change', function() {
    if (inpFrom.value <= inpTo.value) showRange(inpFrom.value, inpTo.value);
  });


	// Hamburger menu
	var hamBtn = document.getElementById('hamBtn');
	var hamPanel = document.getElementById('hamPanel');
	hamBtn.addEventListener('click', function(e) { e.stopPropagation(); hamPanel.style.display = hamPanel.style.display === 'none' ? 'block' : 'none'; });
	document.addEventListener('click', function() { hamPanel.style.display = 'none'; });
	hamPanel.addEventListener('click', function(e) { e.stopPropagation(); });

	// Route
	var menuRoute = document.getElementById('menuRoute');
	var routeState = localStorage.getItem(STORAGE_KEY);
	if (routeState === null) routeState = 'true';
	menuRoute.checked = routeState === 'true';
	function applyRoute(show) {
		document.getElementById('dateFrom').style.display = show ? '' : 'none';
		document.getElementById('dateTo').style.display = show ? '' : 'none';
		document.getElementById('labelFrom').style.display = show ? '' : 'none';
		document.getElementById('labelTo').style.display = show ? '' : 'none';
		var leg = document.getElementById('legend'); if (leg) leg.style.display = show ? 'flex' : 'none';
	}
	if (!menuRoute.checked) {
		applyRoute(false);
		showDay(inpTo.value);
	} else {
		showRange(initFrom, initTo);
	}
	menuRoute.addEventListener('change', function() {
		localStorage.setItem(STORAGE_KEY, this.checked ? 'true' : 'false');
		applyRoute(this.checked);
		if (this.checked) { showRange(inpFrom.value, inpTo.value); } else { showDay(inpTo.value); }
	});

	// Footer
	var menuFooter = document.getElementById('menuFooter');
	var footerState = localStorage.getItem('tracker_footer_circle');
	menuFooter.checked = footerState !== 'false';
	document.getElementById('footer').style.display = menuFooter.checked ? 'flex' : 'none';
	menuFooter.addEventListener('change', function() {
		localStorage.setItem('tracker_footer_circle', this.checked ? 'true' : 'false');
		document.getElementById('footer').style.display = this.checked ? 'flex' : 'none';
	});

	// Map size
	var menuMapSize = document.getElementById('menuMapSize');
	var mapSizeState = localStorage.getItem('tracker_mapsize_circle');
	menuMapSize.checked = mapSizeState === 'true';
	var mapSizeEl = document.getElementById('mapSizeLabel');
	if (mapSizeEl) mapSizeEl.style.display = menuMapSize.checked ? '' : 'none';
	menuMapSize.addEventListener('change', function() {
		localStorage.setItem('tracker_mapsize_circle', this.checked ? 'true' : 'false');
		if (mapSizeEl) mapSizeEl.style.display = this.checked ? '' : 'none';
	});

	// Places
	if (SHOW_PLACES) {
		var menuPlaces = document.getElementById('menuPlaces');
		menuPlaces.checked = localStorage.getItem(PLACES_STORAGE_KEY) !== 'false';
		menuPlaces.addEventListener('change', function() {
			localStorage.setItem(PLACES_STORAGE_KEY, this.checked ? 'true' : 'false');
			renderPlaceFlags();
		});
	}
	if (SHOW_MYPLACES) {
		var menuMyPlaces = document.getElementById('menuMyPlaces');
		menuMyPlaces.checked = localStorage.getItem(MYPLACES_STORAGE_KEY) !== 'false';
		menuMyPlaces.addEventListener('change', function() {
			localStorage.setItem(MYPLACES_STORAGE_KEY, this.checked ? 'true' : 'false');
			renderMyPlaceFlags();
		});
	}
	renderPlaceFlags();
	renderMyPlaceFlags();

  setTimeout(function() {
    const url = new URL(window.location.href);
    url.searchParams.set('_t', Date.now());
    window.location.replace(url.toString());
  }, ${refresh} * 1000);
</` +
			`script>
</body>
</html>`
		);
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
	 * @returns {boolean} True if the minimum distance to the last point of today's feature is exceeded
	 */
	_shouldUpdate(fc, lat, lon) {
		const today = new Date().toISOString().slice(0, 10);
		const feature = fc.features.find(f => f.properties.date === today);
		if (!feature || feature.geometry.coordinates.length === 0) {
			return true;
		}
		const last = feature.geometry.coordinates[feature.geometry.coordinates.length - 1];
		return this._getDistance(last[1], last[0], lat, lon) >= this.config.minDistance;
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
