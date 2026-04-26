"use strict";

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
 *   tracker.config.color.pageBg / headerBg / headerBorder / headerText / routeWeight / routeOpacity
 */
class Tracker {
	/**
	 * @param {import('../main')} adapter - ioBroker adapter instance
	 */
	constructor(adapter) {
		this.adapter = adapter;
		this.config = {};
		this.subscriptions = [];
		this._personIdCache = {};
		// UUID-based mapping: latState-ID → person object
		this._latStateMap = {};
		// Relative IDs of tracker.config.* states (for onStateChange routing)
		this._configStateIds = new Set();
	}

	// ─────────────────────────────────────────────
	// PUBLIC
	// ─────────────────────────────────────────────

	/**
	 * Initializes the tracker
	 *
	 * @returns {Promise<void>} Resolved when initialization of all persons is complete
	 */
	async init() {
		this._loadConfig();

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

		this.adapter.log.info(`[Tracker] Initialized (${activePeople.length} person(s))`);
	}

	/**
	 * Stops the tracker and cleans up subscriptions
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
	 * Loads the base configuration from adapter.config (no state reads here)
	 */
	_loadConfig() {
		const c = this.adapter.config;
		this.adapter.log.info(`[Tracker] DEBUG config keys: ${JSON.stringify(Object.keys(c))}`);
		this.adapter.log.info(`[Tracker] DEBUG pollInterval raw: ${c.life360_polling_interval}`);
		this.config = {
			enabled: c.tracker_enabled ?? false,
			minDistance: c.tracker_min_distance ?? 20,
			pollInterval: c.life360_polling_interval ?? 60,
			namespace: this.adapter.namespace,
			people: c.tracker_people || [],
			familyName: (c.tracker_family_name || "family").toLowerCase().replace(/\s+/g, "_"),
			mapColors: {
				pageBg: c.tracker_color_page_bg || "#1a1a2e",
				headerBg: c.tracker_color_header_bg || "#16213e",
				headerBorder: c.tracker_color_header_border || "#0f3460",
				headerText: c.tracker_color_header_text || "#aaaaaa",
				routeWeight: c.tracker_route_weight ?? 4,
				routeOpacity: c.tracker_route_opacity ?? 0.85,
			},
		};
	}

	/**
	 * Defines all tracker.config.* states with their metadata and default values.
	 * Default value = current this.config value (set by _loadConfig from adapter.config).
	 *
	 * @returns {Array<{id:string, value:any, meta:object}>} Array of config state definitions with id, default value and ioBroker common metadata
	 */
	_configStateDefs() {
		const mc = this.config.mapColors;
		return [
			{
				id: "tracker.config.enabled",
				value: this.config.enabled,
				meta: { name: "Fahrtenbuch aktiv", type: "boolean", role: "switch", read: true, write: true },
			},
			{
				id: "tracker.config.minDistance",
				value: this.config.minDistance,
				meta: {
					name: "Mindestabstand (Meter)",
					type: "number",
					role: "value",
					unit: "m",
					min: 5,
					max: 500,
					read: true,
					write: true,
				},
			},
			{
				id: "tracker.config.color.pageBg",
				value: mc.pageBg,
				meta: {
					name: "Karte – Seitenhintergrund",
					type: "string",
					role: "level.color.hex",
					read: true,
					write: true,
				},
			},
			{
				id: "tracker.config.color.headerBg",
				value: mc.headerBg,
				meta: {
					name: "Karte – Header-Hintergrund",
					type: "string",
					role: "level.color.hex",
					read: true,
					write: true,
				},
			},
			{
				id: "tracker.config.color.headerBorder",
				value: mc.headerBorder,
				meta: {
					name: "Karte – Header-Rahmen",
					type: "string",
					role: "level.color.hex",
					read: true,
					write: true,
				},
			},
			{
				id: "tracker.config.color.headerText",
				value: mc.headerText,
				meta: { name: "Karte – Header-Text", type: "string", role: "level.color.hex", read: true, write: true },
			},
			{
				id: "tracker.config.color.routeWeight",
				value: mc.routeWeight,
				meta: {
					name: "Karte – Linienbreite (px)",
					type: "number",
					role: "value",
					min: 1,
					max: 10,
					read: true,
					write: true,
				},
			},
			{
				id: "tracker.config.color.routeOpacity",
				value: mc.routeOpacity,
				meta: {
					name: "Karte – Liniendeckung (0-1)",
					type: "number",
					role: "value",
					min: 0,
					max: 1,
					read: true,
					write: true,
				},
			},
		];
	}

	/**
	 * Creates tracker.config.* channel + states if they do not exist yet,
	 * and subscribes to changes so onStateChange can react.
	 * On first run the adapter.config value is used; afterwards the stored state value wins.
	 *
	 * @returns {Promise<void>} Resolved after all tracker.config.* states have been created and subscribed
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
			common: { name: "Tracker Konfiguration" },
			native: {},
		});
		await this.adapter.setObjectNotExistsAsync(`${ns}.tracker.config.color`, {
			type: "channel",
			common: { name: "Karten-Farben" },
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
				await this.adapter.setStateAsync(fullId, def.value, true);
				this.adapter.log.debug(`[Tracker] Config state created: ${def.id} = ${def.value}`);
			}
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
	 * @returns {Promise<void>} Resolved after all config state values have been read and merged into this.config
	 */
	async _loadConfigFromStates() {
		const ns = this.config.namespace;
		const get = async id => {
			const s = await this.adapter.getStateAsync(`${ns}.${id}`);
			return s?.val ?? null;
		};

		const enabled = await get("tracker.config.enabled");
		const minDist = await get("tracker.config.minDistance");
		const pageBg = await get("tracker.config.color.pageBg");
		const headerBg = await get("tracker.config.color.headerBg");
		const headerBorder = await get("tracker.config.color.headerBorder");
		const headerText = await get("tracker.config.color.headerText");
		const routeWeight = await get("tracker.config.color.routeWeight");
		const routeOpacity = await get("tracker.config.color.routeOpacity");

		if (enabled !== null) {
			this.config.enabled = !!enabled;
		}
		if (minDist !== null) {
			this.config.minDistance = Number(minDist);
		}
		if (pageBg !== null) {
			this.config.mapColors.pageBg = pageBg;
		}
		if (headerBg !== null) {
			this.config.mapColors.headerBg = headerBg;
		}
		if (headerBorder !== null) {
			this.config.mapColors.headerBorder = headerBorder;
		}
		if (headerText !== null) {
			this.config.mapColors.headerText = headerText;
		}
		if (routeWeight !== null) {
			this.config.mapColors.routeWeight = Number(routeWeight);
		}
		if (routeOpacity !== null) {
			this.config.mapColors.routeOpacity = Number(routeOpacity);
		}

		this.adapter.log.debug(`[Tracker] Config loaded from states (enabled=${this.config.enabled})`);
	}

	/**
	 * Applies a single tracker.config.* state change at runtime.
	 * Color changes immediately re-render all maps.
	 *
	 * @param {string} shortId - Relative ID without namespace (e.g. "tracker.config.enabled")
	 * @param {any} val - New value
	 * @returns {Promise<void>} Resolved after the config value has been updated and affected maps re-rendered
	 */
	async _applyConfigStateChange(shortId, val) {
		this.adapter.log.info(`[Tracker] Config state changed: ${shortId} = ${val}`);

		switch (shortId) {
			case "tracker.config.enabled":
				this.config.enabled = !!val;
				if (!this.config.enabled) {
					this.adapter.log.info("[Tracker] Fahrtenbuch deaktiviert. Adapter neu starten zum Reaktivieren.");
				} else {
					this.adapter.log.info(
						"[Tracker] Fahrtenbuch aktiviert. Adapter neu starten um Tracking zu starten.",
					);
				}
				return; // no map re-render needed

			case "tracker.config.minDistance":
				this.config.minDistance = Number(val);
				return; // no map re-render needed

			case "tracker.config.color.pageBg":
				this.config.mapColors.pageBg = val;
				break;
			case "tracker.config.color.headerBg":
				this.config.mapColors.headerBg = val;
				break;
			case "tracker.config.color.headerBorder":
				this.config.mapColors.headerBorder = val;
				break;
			case "tracker.config.color.headerText":
				this.config.mapColors.headerText = val;
				break;
			case "tracker.config.color.routeWeight":
				this.config.mapColors.routeWeight = Number(val);
				break;
			case "tracker.config.color.routeOpacity":
				this.config.mapColors.routeOpacity = Number(val);
				break;
			default:
				return;
		}

		// Color changed → re-render all maps immediately
		await this._rerenderAllMaps();
	}

	/**
	 * Re-renders all active person maps and the family map from their current allTime GeoJSON.
	 * Called when a map color setting changes at runtime.
	 *
	 * @returns {Promise<void>} Resolved after all person and family maps have been re-rendered
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
	 * @returns {Promise<void>} Resolved after all persons from Life360 have been synchronized
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
			await this._ensureState(paths.allTime, JSON.stringify(allTimeFC), {
				name: `GeoJSON ${person.name} (all time)`,
				type: "string",
				role: "json",
				read: true,
				write: false,
			});
		} else {
			try {
				allTimeFC = JSON.parse(existingAllTime.val);
				// If today's feature is missing entirely, seed it with current location
				const today = new Date().toISOString().slice(0, 10);
				const todayFeat = allTimeFC.features.find(f => f.properties.date === today);
				if (!todayFeat && latState?.val != null && longState?.val != null) {
					const seedTs = latState.ts || Date.now();
					this._addPointToFC(allTimeFC, longState.val, latState.val, seedTs);
					await this.adapter.setStateAsync(
						`${this.config.namespace}.${paths.allTime}`,
						JSON.stringify(allTimeFC),
						true,
					);
					this.adapter.log.debug(`[Tracker:${person.name}] Seeded today's feature with current location`);
				}
			} catch (e) {
				this.adapter.log.warn(`[Tracker:${person.name}] allTime parse error: ${e.message}`);
				allTimeFC = this._emptyFeatureCollection();
			}
		}

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

		// Collect allTime GeoJSONs from all persons
		const personFCs = [];
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
				personFCs.push({ person, fc });
			} catch (e) {
				this.adapter.log.warn(`[Tracker:family] Parse error for ${person.name}: ${e.message}`);
			}
		}

		if (personFCs.length === 0) {
			return;
		}

		// Assemble family FeatureCollection
		const familyFC = {
			type: "FeatureCollection",
			features: personFCs.flatMap(({ fc }) => fc.features || []),
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

		await this._ensureState(familyPaths.url, this._buildFamilyUrl(), {
			name: "Family - Map URL",
			type: "string",
			role: "url",
			read: true,
			write: false,
		});

		const html = this._generateFamilyHTML(personFCs);
		await new Promise((resolve, reject) => {
			this.adapter.writeFile(ns, familyPaths.filePath, html, err => {
				if (err) {
					this.adapter.log.error(`[Tracker:family] writeFile error: ${err}`);
					reject(err);
				} else {
					resolve();
				}
			});
		});

		this.adapter.log.debug("[Tracker:family] Family map updated");
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
	_writeMap(person, fc) {
		const html = this._generateHTML(person, fc);
		const paths = this._getPaths(person.name);
		return new Promise((resolve, reject) => {
			this.adapter.writeFile(this.config.namespace, paths.filePath, html, err => {
				if (err) {
					this.adapter.log.error(`[Tracker:${person.name}] writeFile error: ${err}`);
					reject(err);
				} else {
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
	 * @returns {string} Complete HTML string of the Leaflet single-person map with day dropdown
	 */
	_generateHTML(person, fc) {
		const c = this.config.mapColors;
		const color = person.color || "#4a90e2";
		const dark = this._darkenColor(color, 0.6);
		const refresh = this.config.pollInterval + 10;
		const features = (fc.features || []).filter(f => f.geometry?.coordinates?.length > 0);

		if (features.length === 0) {
			return this._emptyHTML(person.name, c);
		}

		const today = new Date().toISOString().slice(0, 10);
		const dates = features.map(f => f.properties.date);
		const selDate = dates.includes(today) ? today : dates[dates.length - 1];

		const featuresJSON = JSON.stringify(
			features.map(f => ({
				date: f.properties.date,
				coords: f.geometry.coordinates.map(coord => [coord[1], coord[0]]),
				timestamps: f.geometry.coordinates.map(coord => coord[2] || null),
				color: f.properties.color || color,
			})),
		);

		return (
			`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="${refresh}">
<title>${person.name} – Tracker</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></` +
			`script>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:sans-serif; background:${c.pageBg}; color:#eee; display:flex; flex-direction:column; height:100vh; }
  #header { padding:8px 14px; background:${c.headerBg}; display:flex; align-items:center; justify-content:space-between; font-size:13px; border-bottom:2px solid ${c.headerBorder}; flex-wrap:wrap; gap:6px; }
  #header h2 { font-size:15px; color:${color}; margin:0; white-space:nowrap; }
  #header-right { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-left:auto; }
  #headerInfo { color:${c.headerText}; }
  .range-label { color:${c.headerText}; font-size:12px; white-space:nowrap; }\n  input[type=date] { background:${c.headerBg}; color:#eee; border:1px solid ${c.headerBorder}; border-radius:4px; padding:3px 6px; font-size:13px; cursor:pointer; color-scheme:dark; }
  #map { flex:1; }
</style>
</head>
<body>
<div id="header">
  <h2>📍 ${person.name}</h2>
  <div id="header-right">
    <span id="headerInfo"></span>
    <span class="range-label">Von</span>\n    <input type="date" id="dateFrom">\n    <span class="range-label">Bis</span>\n    <input type="date" id="dateTo">
  </div>
</div>
<div id="map"></div>
<script>
  const FEATURES = ${featuresJSON};
  const COLOR    = "${color}";
  const DARK     = "${dark}";
  const SEL_DATE = "${selDate}";

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

  function showDay(date) {
    clearLayers();
    const feat = FEATURES.find(f => f.date === date);
    if (!feat || feat.coords.length === 0) return;

    const c      = feat.color || COLOR;
    const ts     = feat.timestamps;
    const coords = feat.coords;

    const line = L.polyline(coords, { color:c, weight:${c.routeWeight}, opacity:${c.routeOpacity} }).addTo(map);
    layers.push(line);

    layers.push(
      L.circleMarker(coords[0], { radius:8, fillColor:DARK, color:'#fff', weight:2, fillOpacity:1 })
        .bindPopup('▶ Start: ' + fmt(ts[0])).addTo(map)
    );
    layers.push(
      L.circleMarker(coords[coords.length-1], { radius:10, fillColor:c, color:'#fff', weight:2, fillOpacity:1 })
        .bindPopup('⬛ Last: ' + fmt(ts[ts.length-1])).addTo(map)
    );

    coords.forEach(function(coord, i) {
      if (i === 0 || i === coords.length-1) return;
      layers.push(
        L.circleMarker(coord, { radius:4, fillColor:c, color:'#fff', weight:1, fillOpacity:0.6 })
          .bindPopup(fmt(ts[i])).addTo(map)
      );
    });

    map.fitBounds(line.getBounds(), { padding:[30,30] });
    document.getElementById('headerInfo').textContent =
      'Start: ' + fmt(ts[0]) + '  ·  Last point: ' + fmt(ts[ts.length-1]) + '  ·  ' + coords.length + ' points';
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
    const bounds = [];
    feats.forEach(function(feat) {
      const fc = feat.color || COLOR;
      const ts = feat.timestamps; const coords = feat.coords;
      const line = L.polyline(coords, { color:fc, weight:${c.routeWeight}, opacity:${c.routeOpacity} }).addTo(map);
      layers.push(line); bounds.push(...coords);
      layers.push(L.circleMarker(coords[0], { radius:7, fillColor:DARK, color:'#fff', weight:2, fillOpacity:1 })
        .bindPopup(feat.date + '<br>▶ ' + fmt(ts[0])).addTo(map));
      layers.push(L.circleMarker(coords[coords.length-1], { radius:9, fillColor:fc, color:'#fff', weight:2, fillOpacity:1 })
        .bindPopup(feat.date + '<br>⬛ ' + fmt(ts[ts.length-1])).addTo(map));
    });
    if (bounds.length > 0) map.fitBounds(L.latLngBounds(bounds), { padding:[30,30] });
    const pts = feats.reduce((s,f) => s + f.coords.length, 0);
    document.getElementById('headerInfo').textContent = feats.length + ' Tag(e) · ' + pts + ' Punkte';
    location.hash = from + '_' + to;
  }

  inpFrom.addEventListener('change', function() { if (inpFrom.value <= inpTo.value) showRange(inpFrom.value, inpTo.value); });
  inpTo.addEventListener('change', function() { if (inpFrom.value <= inpTo.value) showRange(inpFrom.value, inpTo.value); });
  showRange(initFrom, initTo);
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
	// HTML – FAMILY MAP
	// ─────────────────────────────────────────────

	/**
	 * Generates the HTML content of the family map with dropdown and legend
	 *
	 * @param {{person:{name:string,color:string}, fc:object}[]} personFCs
	 * @returns {string} Complete HTML string of the Leaflet family map with dropdown and legend
	 */
	_generateFamilyHTML(personFCs) {
		const c = this.config.mapColors;
		const refresh = this.config.pollInterval + 10;

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
			return this._emptyHTML("Family", c);
		}

		const allDates = [...new Set(allFeatures.map(f => f.date))].sort();
		const today = new Date().toISOString().slice(0, 10);
		const selDate = allDates.includes(today) ? today : allDates[allDates.length - 1];

		const legendItems = personFCs
			.map(
				({ person }) =>
					`<span style="display:inline-flex;align-items:center;gap:5px;margin-right:10px">` +
					`<span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${person.color}"></span>` +
					`${person.name}</span>`,
			)
			.join("");

		const featuresJSON = JSON.stringify(allFeatures);

		return (
			`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="${refresh}">
<title>Family – Tracker</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></` +
			`script>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:sans-serif; background:${c.pageBg}; color:#eee; display:flex; flex-direction:column; height:100vh; }
  #header { padding:8px 14px; background:${c.headerBg}; display:flex; align-items:center; justify-content:space-between; font-size:13px; border-bottom:2px solid ${c.headerBorder}; flex-wrap:wrap; gap:6px; }
  #header h2 { font-size:15px; color:#eee; margin:0; white-space:nowrap; }
  #header-right { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-left:auto; }
  #legend { color:${c.headerText}; font-size:12px; }
  .range-label { color:${c.headerText}; font-size:12px; white-space:nowrap; }
  input[type=date] { background:${c.headerBg}; color:#eee; border:1px solid ${c.headerBorder}; border-radius:4px; padding:3px 6px; font-size:13px; cursor:pointer; color-scheme:dark; }
  #map { flex:1; }
</style>
</head>
<body>
<div id="header">
  <h2>👨‍👩‍👧 Family</h2>
  <div id="header-right">
    <div id="legend">${legendItems}</div>
    <span class="range-label">Von</span>
    <input type="date" id="dateFrom">
    <span class="range-label">Bis</span>
    <input type="date" id="dateTo">
  </div>
</div>
<div id="map"></div>
<script>
  const FEATURES = ${featuresJSON};
  const SEL_DATE = "${selDate}";

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

  function darken(hex, f) {
    const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
    return '#' + [r,g,b].map(v => Math.round(v*f).toString(16).padStart(2,'0')).join('');
  }

  function showDay(date) {
    clearLayers();
    const dayFeats = FEATURES.filter(f => f.date === date && f.coords.length > 0);
    if (dayFeats.length === 0) return;

    const bounds = [];
    dayFeats.forEach(function(feat) {
      const c      = feat.color;
      const dark   = darken(c, 0.6);
      const coords = feat.coords;
      const ts     = feat.timestamps;

      const line = L.polyline(coords, { color:c, weight:${c.routeWeight}, opacity:${c.routeOpacity} }).addTo(map);
      layers.push(line);
      bounds.push(...coords);

      layers.push(
        L.circleMarker(coords[0], { radius:7, fillColor:dark, color:'#fff', weight:2, fillOpacity:1 })
          .bindPopup(feat.name + '<br>▶ Start: ' + fmt(ts[0])).addTo(map)
      );
      layers.push(
        L.circleMarker(coords[coords.length-1], { radius:9, fillColor:c, color:'#fff', weight:2, fillOpacity:1 })
          .bindPopup(feat.name + '<br>⬛ Last: ' + fmt(ts[ts.length-1])).addTo(map)
      );

      coords.forEach(function(coord, i) {
        if (i === 0 || i === coords.length-1) return;
        layers.push(
          L.circleMarker(coord, { radius:3, fillColor:c, color:'#fff', weight:1, fillOpacity:0.55 })
            .bindPopup(feat.name + '<br>' + fmt(ts[i])).addTo(map)
        );
      });
    });

    if (bounds.length > 0) map.fitBounds(L.latLngBounds(bounds), { padding:[30,30] });
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
    const bounds = [];
    feats.forEach(function(feat) {
      const c    = feat.color;
      const dark = darken(c, 0.6);
      const ts   = feat.timestamps; const coords = feat.coords;
      const line = L.polyline(coords, { color:c, weight:${c.routeWeight}, opacity:${c.routeOpacity} }).addTo(map);
      layers.push(line); bounds.push(...coords);
      layers.push(L.circleMarker(coords[0], { radius:7, fillColor:dark, color:'#fff', weight:2, fillOpacity:1 })
        .bindPopup(feat.name + ' ' + feat.date + '<br>▶ ' + fmt(ts[0])).addTo(map));
      layers.push(L.circleMarker(coords[coords.length-1], { radius:9, fillColor:c, color:'#fff', weight:2, fillOpacity:1 })
        .bindPopup(feat.name + ' ' + feat.date + '<br>⬛ ' + fmt(ts[ts.length-1])).addTo(map));
    });
    if (bounds.length > 0) map.fitBounds(L.latLngBounds(bounds), { padding:[30,30] });
    location.hash = from + '_' + to;
  }

  inpFrom.addEventListener('change', function() { if (inpFrom.value <= inpTo.value) showRange(inpFrom.value, inpTo.value); });
  inpTo.addEventListener('change', function() { if (inpFrom.value <= inpTo.value) showRange(inpFrom.value, inpTo.value); });
  showRange(initFrom, initTo);
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
	 * Empty HTML page indicating no data available
	 *
	 * @param {string} name
	 * @param {object} c - mapColors
	 * @returns {string} Empty HTML page indicating no data available
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
		const ip = this._getLocalIP();
		const safe = person.name.toLowerCase().replace(/\s+/g, "_");
		return `http://${ip}:8082/${this.config.namespace}/tracker/${safe}.html`;
	}

	/**
	 * Builds the URL for the family map
	 *
	 * @returns {string} Full HTTP URL to the family HTML map file
	 */
	_buildFamilyUrl() {
		const ip = this._getLocalIP();
		return `http://${ip}:8082/${this.config.namespace}/tracker/${this.config.familyName}.html`;
	}

	/**
	 * Returns the first external IPv4 address found, or 127.0.0.1 as fallback
	 *
	 * @returns {string} First non-internal IPv4 address found, or 127.0.0.1 as fallback
	 */
	_getLocalIP() {
		try {
			const os = require("os");
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
	 * @returns {Promise<void>}
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
