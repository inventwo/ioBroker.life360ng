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
		// Last date on which retention purge was executed (YYYY-MM-DD)
		this._lastPurgeDate = null;
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
				headerText: c.tracker_color_header_text || "#aaaaaa",
				routeWeight: c.tracker_route_weight ?? 4,
				routeOpacity: c.tracker_route_opacity ?? 0.85,
				markerOpacity: c.tracker_marker_opacity ?? 1,
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

		// ── monthly state + JSON file ─────────────────────
		const existingMonth = await this.adapter.getStateAsync(`${this.config.namespace}.${paths.geojson}`);
		let monthFC;

		if (!existingMonth || existingMonth.val == null) {
			monthFC = this._emptyFeatureCollection();
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
		} else {
			try {
				monthFC = JSON.parse(existingMonth.val);
			} catch (e) {
				this.adapter.log.warn(`[Tracker:${person.name}] monthly parse error on init: ${e.message}`);
				monthFC = this._emptyFeatureCollection();
			}
		}

		// Write monthly JSON file and update manifest on startup
		const safeName = person.name.toLowerCase().replace(/\s+/g, "_");
		await this._writeMonthFile(safeName, monthFC);

		// HTML shell (no data embedded – always up to date after manifest/JSON written)
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

		// ── Write monthly JSON file + update manifest ────
		const safe = person.name.toLowerCase().replace(/\s+/g, "_");
		await this._writeMonthFile(safe, monthFC);

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

		const html = await this._generateFamilyHTML(personFCs);
		await new Promise((resolve, reject) => {
			this.adapter.writeFile(ns, familyPaths.filePath, html, async err => {
				// ← async NEU
				if (err) {
					this.adapter.log.error(`[Tracker:circle] writeFile error: ${err}`);
					reject(err);
				} else {
					// ── NEU ──────────────────────────────────────────
					const sizeKB = Math.round((Buffer.byteLength(html, "utf8") / 1024) * 100) / 100;
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
	// MONTHLY JSON + MANIFEST
	// ─────────────────────────────────────────────

	/**
	 * Writes the GeoJSON for the current month as a static file and updates the manifest.
	 * Called whenever route data is updated.
	 *
	 * @param {string} safe - Safe name (lowercase, underscores)
	 * @param {object} monthFC - FeatureCollection for the current month
	 * @returns {Promise<void>}
	 */
	async _writeMonthFile(safe, monthFC) {
		const now = new Date();
		const year = String(now.getFullYear());
		const month = String(now.getMonth() + 1).padStart(2, "0");
		const ns = this.config.namespace;
		const filePath = this._getMonthFilePath(safe, year, month);

		await new Promise((resolve, reject) => {
			this.adapter.writeFile(ns, filePath, JSON.stringify(monthFC), err => {
				if (err) {
					this.adapter.log.warn(`[Tracker:${safe}] writeMonthFile error: ${err}`);
					reject(err);
				} else {
					resolve();
				}
			});
		});

		await this._updateManifest(safe, year, month);
	}

	/**
	 * Reads the existing manifest, adds the given year-month entry if missing, and writes it back.
	 *
	 * @param {string} safe - Safe name
	 * @param {string} year - 4-digit year string
	 * @param {string} month - 2-digit month string
	 * @returns {Promise<void>}
	 */
	async _updateManifest(safe, year, month) {
		const ns = this.config.namespace;
		const manifestPath = `tracker/${safe}/manifest.json`;
		const entry = `${year}-${month}`;

		let manifest = { months: [] };
		await new Promise(resolve => {
			this.adapter.readFile(ns, manifestPath, (err, data) => {
				if (!err && data) {
					try {
						manifest = JSON.parse(typeof data === "string" ? data : data.toString());
					} catch {
						/* use empty manifest */
					}
				}
				resolve();
			});
		});

		if (!manifest.months.includes(entry)) {
			manifest.months.push(entry);
			manifest.months.sort();
		}
		manifest.updated = new Date().toISOString();

		await new Promise((resolve, reject) => {
			this.adapter.writeFile(ns, manifestPath, JSON.stringify(manifest), err => {
				if (err) {
					this.adapter.log.warn(`[Tracker:${safe}] updateManifest error: ${err}`);
					reject(err);
				} else {
					resolve();
				}
			});
		});
	}

	/**
	 * Removes a year-month entry from the manifest (called by retention purge).
	 *
	 * @param {string} safe - Safe name
	 * @param {string} yearMonth - Entry in the form "YYYY-MM"
	 * @returns {Promise<void>}
	 */
	async _removeFromManifest(safe, yearMonth) {
		const ns = this.config.namespace;
		const manifestPath = `tracker/${safe}/manifest.json`;

		let manifest = { months: [] };
		await new Promise(resolve => {
			this.adapter.readFile(ns, manifestPath, (err, data) => {
				if (!err && data) {
					try {
						manifest = JSON.parse(typeof data === "string" ? data : data.toString());
					} catch {
						/* use empty manifest */
					}
				}
				resolve();
			});
		});

		manifest.months = manifest.months.filter(m => m !== yearMonth);
		manifest.updated = new Date().toISOString();

		await new Promise(resolve => {
			this.adapter.writeFile(ns, manifestPath, JSON.stringify(manifest), () => resolve());
		});
	}

	// ─────────────────────────────────────────────
	// HTML – SINGLE MAP
	// ─────────────────────────────────────────────

	/**
	 * Writes the HTML map as a file (static shell, no embedded route data)
	 *
	 * @param {{name:string, color:string}} person
	 * @param {object} fc - FeatureCollection (allTime) – used only for log point count
	 * @returns {Promise<void>} Resolved after the HTML file has been successfully written to the ioBroker filesystem
	 */
	_writeMap(person, fc) {
		const html = String(this._generateHTML(person, person.ownMap !== false));
		const paths = this._getPaths(person.name);
		return new Promise((resolve, reject) => {
			this.adapter.writeFile(this.config.namespace, paths.filePath, html, async err => {
				if (err) {
					this.adapter.log.error(`[Tracker:${person.name}] writeFile error: ${err}`);
					reject(err);
				} else {
					const sizeKB = Math.round((Buffer.byteLength(html, "utf8") / 1024) * 100) / 100;
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
	 * Generates the static HTML shell for the single-person map.
	 * Route data is NOT embedded – the browser loads it dynamically via fetch from monthly JSON files.
	 *
	 * @param {{name:string, color:string, id?:string}} person
	 * @param {boolean} includeRoute - If false only the last point per day is shown
	 * @returns {string} Complete HTML string
	 */
	_generateHTML(person, includeRoute = true) {
		const c = this.config.mapColors;
		const color = person.color || "#4a90e2";
		const dark = this._darkenColor(color, 0.6);
		const firstName = person.name.split(" ")[0];
		const refresh = this.config.pollInterval + 10;
		const safe = person.name.toLowerCase().replace(/\s+/g, "_");
		const personKey = person.id ? String(person.id) : person.name.replace(/[^a-zA-Z0-9]/g, "_");

		const headerFg = this._getContrastText(c.headerBg);
		const controlBg = this._scaleColor(c.headerBg, 0.82);
		const controlBorder = this._scaleColor(c.headerBg, 0.62);

		// Base path for data files (relative to HTML file location)
		const dataBasePath = `./${safe}/`;

		return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${firstName} – Tracker</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family:sans-serif; background:${c.pageBg}; color:#eee; display:flex; flex-direction:column; height:100vh; color-scheme:${headerFg === "#111111" ? "light" : "dark"}; }
#header { padding:8px 14px; background:${c.headerBg}; display:flex; align-items:center; justify-content:space-between; font-size:13px; border-bottom:2px solid ${c.headerBorder}; flex-wrap:wrap; gap:6px; min-height:44px; }
#header h2 { font-size:15px; color:${headerFg}; margin:0; white-space:nowrap; }
#header-right { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-left:auto; }
#headerInfo { color:${headerFg}; font-size:12px; }
.range-label { color:${headerFg}; font-size:12px; white-space:nowrap; }
input[type=date] { background:${controlBg}; color:${headerFg}; border:1px solid ${controlBorder}; border-radius:4px; padding:3px 6px; font-size:13px; cursor:pointer; color-scheme:${headerFg === "#111111" ? "light" : "dark"}; }
.route-checkbox-label { display:inline-flex; align-items:center; gap:4px; margin-left:12px; user-select:none; color:${headerFg}; }
.route-checkbox-label input[type="checkbox"] { vertical-align:middle; accent-color:${color}; margin:0; }
#map { flex:1; }
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
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
const COLOR          = "${color}";
const DARK           = "${dark}";
const MARKER_OPACITY = ${c.markerOpacity};
const ROUTE_WEIGHT   = ${c.routeWeight};
const ROUTE_OPACITY  = ${c.routeOpacity};
const INCLUDE_ROUTE  = ${includeRoute};
const DATA_BASE      = "${dataBasePath}";
const STORAGE_KEY    = "tracker_showRoute_${personKey}";
const REFRESH_SEC    = ${refresh};

const map = L.map('map');
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© OpenStreetMap', maxZoom: 19
}).addTo(map);

let layers = [];
// Cache: "YYYY-MM" → array of feature objects {date, coords, timestamps, color}
const featureCache = {};
// All available months from manifest
let allMonths = [];
// All available dates (derived from loaded months)
let allDates = [];

function clearLayers() { layers.forEach(l => map.removeLayer(l)); layers = []; }

function fmt(ts) {
  if (!ts) return '–';
  return new Date(ts).toLocaleTimeString('de-DE', { hour:'2-digit', minute:'2-digit' });
}

function pinIcon(c) {
  return L.divIcon({
    className: '',
    html: '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="36" viewBox="0 0 28 36" style="opacity:' + MARKER_OPACITY + '"><path d="M14 0C6.27 0 0 6.27 0 14c0 9.33 14 22 14 22S28 23.33 28 14C28 6.27 21.73 0 14 0z" fill="' + c + '" stroke="#fff" stroke-width="2"/><circle cx="14" cy="14" r="5" fill="#fff"/></svg>',
    iconSize: [28, 36], iconAnchor: [14, 36], popupAnchor: [0, -36]
  });
}

/** Loads (and caches) all monthly JSON files whose year-month overlaps with [from, to]. */
async function loadMonthsForRange(from, to) {
  const fromYM = from.slice(0, 7); // "YYYY-MM"
  const toYM   = to.slice(0, 7);
  const needed = allMonths.filter(m => m >= fromYM && m <= toYM);
  for (const ym of needed) {
    if (featureCache[ym] !== undefined) continue;
    try {
      const resp = await fetch(DATA_BASE + ym + '.json?_t=' + Date.now());
      if (!resp.ok) { featureCache[ym] = []; continue; }
      const fc = await resp.json();
      featureCache[ym] = (fc.features || [])
        .filter(f => f.geometry && f.geometry.coordinates && f.geometry.coordinates.length > 0)
        .map(f => {
          if (INCLUDE_ROUTE) {
            return {
              date: f.properties.date,
              coords: f.geometry.coordinates.map(c => [c[1], c[0]]),
              timestamps: f.geometry.coordinates.map(c => c[2] || null),
              color: f.properties.color || COLOR,
            };
          }
          // Only last point
          const last = f.geometry.coordinates[f.geometry.coordinates.length - 1];
          return {
            date: f.properties.date,
            coords: last ? [[last[1], last[0]]] : [],
            timestamps: last ? [last[2] || null] : [],
            color: f.properties.color || COLOR,
          };
        });
    } catch(e) {
      featureCache[ym] = [];
    }
  }
}

/** Returns all cached features for the given date range. */
function getFeaturesForRange(from, to) {
  const fromYM = from.slice(0, 7);
  const toYM   = to.slice(0, 7);
  const feats = [];
  for (const ym of allMonths) {
    if (ym < fromYM || ym > toYM) continue;
    for (const f of (featureCache[ym] || [])) {
      if (f.date >= from && f.date <= to && f.coords.length > 0) feats.push(f);
    }
  }
  return feats;
}

function renderRange(feats) {
  clearLayers();
  if (feats.length === 0) return;
  const showRoute = document.getElementById('showRoute').checked;
  const bounds = [];

  feats.forEach(function(feat) {
    const fc     = feat.color || COLOR;
    const ts     = feat.timestamps;
    const coords = feat.coords;
    if (showRoute) {
      layers.push(L.polyline(coords, { color:fc, weight:ROUTE_WEIGHT, opacity:ROUTE_OPACITY }).addTo(map));
      bounds.push(...coords);
      if (coords.length > 1) {
        layers.push(L.circleMarker(coords[0], { radius:7, fillColor:DARK, color:'#fff', weight:2, fillOpacity:1 })
          .bindPopup(feat.date + '<br>▶ ' + fmt(ts[0])).addTo(map));
      }
    }
    layers.push(L.marker(coords[coords.length-1], { icon: pinIcon(fc) })
      .bindPopup(feat.date + '<br>📍 ' + fmt(ts[ts.length-1])).addTo(map));
    if (showRoute) {
      coords.forEach(function(coord, i) {
        if (i === 0 || i === coords.length-1) return;
        layers.push(L.circleMarker(coord, { radius:4, fillColor:fc, color:'#fff', weight:1, fillOpacity:0.6 })
          .bindPopup(feat.date + '<br>' + fmt(ts[i])).addTo(map));
      });
    }
  });

  const lastFeat = feats[feats.length-1];
  document.getElementById('headerInfo').textContent = 'Last: ' + fmt(lastFeat.timestamps[lastFeat.timestamps.length-1]);

  if (showRoute && bounds.length > 0) {
    map.fitBounds(L.latLngBounds(bounds), { padding:[30,30] });
  } else {
    const lastPoints = feats.map(f => f.coords[f.coords.length-1]);
    if (lastPoints.length === 1) map.setView(lastPoints[0], 16);
    else map.fitBounds(L.latLngBounds(lastPoints), { padding:[30,30] });
  }
}

const inpFrom = document.getElementById('dateFrom');
const inpTo   = document.getElementById('dateTo');

async function applyRange() {
  const from = inpFrom.value, to = inpTo.value;
  if (!from || !to || from > to) return;
  await loadMonthsForRange(from, to);
  const feats = getFeaturesForRange(from, to);
  renderRange(feats);
  location.hash = from + '_' + to;
}

inpFrom.addEventListener('change', applyRange);
inpTo.addEventListener('change',   applyRange);

const showRouteCheckbox = document.getElementById('showRoute');
let showRouteState = localStorage.getItem(STORAGE_KEY);
if (showRouteState === null) showRouteState = 'true';
showRouteCheckbox.checked = showRouteState === 'true';

showRouteCheckbox.addEventListener('change', function() {
  localStorage.setItem(STORAGE_KEY, this.checked ? 'true' : 'false');
  const show = this.checked;
  document.getElementById('dateFrom').style.display   = show ? '' : 'none';
  document.getElementById('dateTo').style.display     = show ? '' : 'none';
  document.getElementById('labelFrom').style.display  = show ? '' : 'none';
  document.getElementById('labelTo').style.display    = show ? '' : 'none';
  applyRange();
});

// Initial hide/show date pickers
if (!showRouteCheckbox.checked) {
  document.getElementById('dateFrom').style.display  = 'none';
  document.getElementById('dateTo').style.display    = 'none';
  document.getElementById('labelFrom').style.display = 'none';
  document.getElementById('labelTo').style.display   = 'none';
}

// Load manifest and initialize date pickers
(async function init() {
  try {
    const resp = await fetch(DATA_BASE + 'manifest.json?_t=' + Date.now());
    if (!resp.ok) { document.getElementById('headerInfo').textContent = 'No data'; return; }
    const manifest = await resp.json();
    allMonths = (manifest.months || []).sort();
    if (allMonths.length === 0) { document.getElementById('headerInfo').textContent = 'No data'; return; }

    // Derive all dates from allMonths entries (only the months we have)
    // Set date picker bounds from manifest
    const firstMonth = allMonths[0];
    const lastMonth  = allMonths[allMonths.length - 1];
    inpFrom.min = inpTo.min = firstMonth + '-01';
    const lastMonthDate = new Date(parseInt(lastMonth.slice(0,4)), parseInt(lastMonth.slice(5,7)), 0);
    inpFrom.max = inpTo.max = lastMonthDate.toISOString().slice(0,10);

    const today = new Date().toISOString().slice(0,10);
    let initFrom = today, initTo = today;
    if (location.hash) {
      const parts = location.hash.slice(1).split('_');
      if (parts.length === 2) { initFrom = parts[0]; initTo = parts[1]; }
    }
    // Clamp to available range
    if (initFrom < inpFrom.min) initFrom = inpFrom.min;
    if (initTo   > inpFrom.max) initTo   = inpFrom.max;
    inpFrom.value = initFrom;
    inpTo.value   = initTo;

    await applyRange();
  } catch(e) {
    document.getElementById('headerInfo').textContent = 'Load error';
  }
})();

setTimeout(function() {
  const url = new URL(window.location.href);
  url.searchParams.set('_t', Date.now());
  window.location.replace(url.toString());
}, REFRESH_SEC * 1000);
</script>
</body>
</html>`;
	}

	// ─────────────────────────────────────────────
	// HTML – CIRCLE MAP
	// ─────────────────────────────────────────────

	/**
	 * Generates the static HTML shell for the circle/family map.
	 * Route data is NOT embedded – the browser loads monthly JSONs per person dynamically via fetch.
	 *
	 * @param {{person:{name:string,color:string}, fc:object}[]} personFCs
	 * @returns {Promise<string>} Complete HTML string
	 */
	async _generateFamilyHTML(personFCs) {
		const c = this.config.mapColors;
		const refresh = this.config.pollInterval + 10;

		const headerFg = this._getContrastText(c.headerBg);
		const controlBg = this._scaleColor(c.headerBg, 0.82);
		const controlHoverBg = this._scaleColor(c.headerBg, 0.72);
		const controlBorder = this._scaleColor(c.headerBg, 0.62);
		const subText = c.headerText || this._scaleColor(headerFg, 0.75);

		// --- Circle Map Header Name: user-defined, circle name, or fallback ---
		let circleName = "Circle";
		if (
			this.config.familyMapHeaderName &&
			typeof this.config.familyMapHeaderName === "string" &&
			this.config.familyMapHeaderName.trim()
		) {
			circleName = this.config.familyMapHeaderName.trim();
		} else {
			try {
				const firstPerson = personFCs[0]?.person;
				let circleId = firstPerson?.circleId;
				if (!circleId && this.config.circleId) {
					circleId = this.config.circleId;
				}
				if (!circleId && this.config.people?.length > 0) {
					circleId = this.config.people[0]?.circleId;
				}
				if (circleId) {
					const stateId = `${this.config.namespace}.circles.${circleId}.name`;
					const state = await this.adapter.getStateAsync(stateId);
					if (state && typeof state.val === "string" && state.val.trim()) {
						circleName = state.val.trim();
					}
				}
			} catch (e) {
				this.adapter.log.warn(`[Tracker] Error reading circle name: ${e.message}`);
			}
		}

		// People metadata (name, color, safe) – no coordinate data embedded
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

		// Embed only lightweight person metadata (name, color, safe path) – no coords
		const peopleMetaJSON = JSON.stringify(
			uniquePeople.map(person => ({
				name: person.name,
				color: person.color,
				safe: person.name.toLowerCase().replace(/\s+/g, "_"),
			})),
		);

		return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
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
.legend-btn { background:${controlBg}; color:${headerFg}; border:1px solid ${controlBorder}; border-radius:4px; padding:4px 8px; font-size:12px; cursor:pointer; transition:background 0.15s ease; }
.legend-btn:hover { background:${controlHoverBg}; }
.legend-item { display:inline-flex; align-items:center; gap:6px; cursor:pointer; user-select:none; color:${headerFg}; }
.legend-item input { margin:0; cursor:pointer; }
.range-label { color:${headerFg}; font-size:12px; white-space:nowrap; }
input[type=date] { background:${controlBg}; color:${headerFg}; border:1px solid ${controlBorder}; border-radius:4px; padding:3px 6px; font-size:13px; cursor:pointer; color-scheme:${headerFg === "#111111" ? "light" : "dark"}; }
#map { flex:1; }
@media (max-width: 900px) { #header { align-items:stretch; } #header-right { width:100%; margin-left:0; } #legendWrap { width:100%; } }
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
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
const PEOPLE_META    = ${peopleMetaJSON};
const MARKER_OPACITY = ${c.markerOpacity};
const ROUTE_WEIGHT   = ${c.routeWeight};
const ROUTE_OPACITY  = ${c.routeOpacity};
const STORAGE_KEY    = "tracker_showRoute_circle";
const REFRESH_SEC    = ${refresh};

// visiblePeople: name → boolean
const visiblePeople = Object.fromEntries(PEOPLE_META.map(p => [p.name, true]));
// featureCache: "personSafe|YYYY-MM" → feature array
const featureCache = {};
// allMonths: union of all person manifests
let allMonths = [];

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
  return L.divIcon({
    className: '',
    html: '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="36" viewBox="0 0 28 36" style="opacity:' + MARKER_OPACITY + '"><path d="M14 0C6.27 0 0 6.27 0 14c0 9.33 14 22 14 22S28 23.33 28 14C28 6.27 21.73 0 14 0z" fill="' + color + '" stroke="#fff" stroke-width="2"/><circle cx="14" cy="14" r="5" fill="#fff"/></svg>',
    iconSize: [28, 36], iconAnchor: [14, 36], popupAnchor: [0, -36]
  });
}

function darken(hex, f) {
  const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
  return '#' + [r,g,b].map(v => Math.round(v*f).toString(16).padStart(2,'0')).join('');
}

/** Loads all manifests and returns union of months */
async function loadManifests() {
  const monthSet = new Set();
  await Promise.all(PEOPLE_META.map(async p => {
    try {
      const resp = await fetch('../' + p.safe + '/manifest.json?_t=' + Date.now());
      if (!resp.ok) return;
      const manifest = await resp.json();
      (manifest.months || []).forEach(m => monthSet.add(m));
    } catch { /* ignore */ }
  }));
  return [...monthSet].sort();
}

/** Loads (and caches) monthly data for all visible people in the given range */
async function loadDataForRange(from, to) {
  const fromYM = from.slice(0,7), toYM = to.slice(0,7);
  const needed = allMonths.filter(m => m >= fromYM && m <= toYM);
  await Promise.all(PEOPLE_META.map(async p => {
    if (!visiblePeople[p.name]) return;
    for (const ym of needed) {
      const key = p.safe + '|' + ym;
      if (featureCache[key] !== undefined) continue;
      try {
        const resp = await fetch('../' + p.safe + '/' + ym + '.json?_t=' + Date.now());
        if (!resp.ok) { featureCache[key] = []; continue; }
        const fc = await resp.json();
        featureCache[key] = (fc.features || [])
          .filter(f => f.geometry && f.geometry.coordinates && f.geometry.coordinates.length > 0)
          .map(f => ({
            date: f.properties.date,
            name: p.name,
            color: p.color,
            coords: f.geometry.coordinates.map(c => [c[1], c[0]]),
            timestamps: f.geometry.coordinates.map(c => c[2] || null),
          }));
      } catch { featureCache[key] = []; }
    }
  }));
}

function getFeaturesForRange(from, to) {
  const fromYM = from.slice(0,7), toYM = to.slice(0,7);
  const feats = [];
  for (const p of PEOPLE_META) {
    if (!visiblePeople[p.name]) continue;
    for (const ym of allMonths) {
      if (ym < fromYM || ym > toYM) continue;
      for (const f of (featureCache[p.safe + '|' + ym] || [])) {
        if (f.date >= from && f.date <= to) feats.push(f);
      }
    }
  }
  return feats;
}

function renderFeatures(feats) {
  clearLayers();
  if (feats.length === 0) return;
  const showRoute = document.getElementById('showRoute').checked;
  const bounds = [];

  feats.forEach(function(feat) {
    const color  = feat.color;
    const dark   = darken(color, 0.6);
    const coords = feat.coords;
    const ts     = feat.timestamps;
    const prefix = feat.name + '<br>';

    if (showRoute) {
      layers.push(L.polyline(coords, { color, weight:ROUTE_WEIGHT, opacity:ROUTE_OPACITY }).addTo(map));
      bounds.push(...coords);
      if (coords.length > 1) {
        layers.push(L.circleMarker(coords[0], { radius:7, fillColor:dark, color:'#fff', weight:2, fillOpacity:1 })
          .bindPopup(prefix + '▶ ' + fmt(ts[0])).addTo(map));
      }
    }
    layers.push(L.marker(coords[coords.length-1], { icon: pinIcon(color) })
      .bindPopup(prefix + '📍 ' + fmt(ts[ts.length-1])).addTo(map));
    if (showRoute) {
      coords.forEach(function(coord, i) {
        if (i === 0 || i === coords.length-1) return;
        layers.push(L.circleMarker(coord, { radius:4, fillColor:color, color:'#fff', weight:1, fillOpacity:0.6 })
          .bindPopup(prefix + fmt(ts[i])).addTo(map));
      });
    }
  });

  if (showRoute && bounds.length > 0) {
    map.fitBounds(L.latLngBounds(bounds), { padding:[30,30] });
  } else if (feats.length > 0) {
    const lastPoints = feats.map(f => f.coords[f.coords.length-1]);
    if (lastPoints.length === 1) map.setView(lastPoints[0], 16);
    else map.fitBounds(L.latLngBounds(lastPoints), { padding:[30,30] });
  }
}

const inpFrom = document.getElementById('dateFrom');
const inpTo   = document.getElementById('dateTo');

async function applyRange() {
  const from = inpFrom.value, to = inpTo.value;
  if (!from || !to || from > to) return;
  await loadDataForRange(from, to);
  renderFeatures(getFeaturesForRange(from, to));
  location.hash = from + '_' + to;
}

inpFrom.addEventListener('change', applyRange);
inpTo.addEventListener('change',   applyRange);

document.querySelectorAll('.personToggle').forEach(cb => {
  cb.addEventListener('change', function() {
    visiblePeople[this.value] = this.checked;
    // Invalidate cache for this person so it reloads if re-enabled
    applyRange();
  });
});

document.getElementById('showAll').addEventListener('click', function() {
  document.querySelectorAll('.personToggle').forEach(cb => { cb.checked = true; visiblePeople[cb.value] = true; });
  applyRange();
});

document.getElementById('hideAll').addEventListener('click', function() {
  document.querySelectorAll('.personToggle').forEach(cb => { cb.checked = false; visiblePeople[cb.value] = false; });
  applyRange();
});

const showRouteCheckbox = document.getElementById('showRoute');
let showRouteState = localStorage.getItem(STORAGE_KEY);
if (showRouteState === null) showRouteState = 'true';
showRouteCheckbox.checked = showRouteState === 'true';

// Initial hide/show date pickers
if (!showRouteCheckbox.checked) {
  document.getElementById('dateFrom').style.display  = 'none';
  document.getElementById('dateTo').style.display    = 'none';
  document.getElementById('labelFrom').style.display = 'none';
  document.getElementById('labelTo').style.display   = 'none';
}

showRouteCheckbox.addEventListener('change', function() {
  localStorage.setItem(STORAGE_KEY, this.checked ? 'true' : 'false');
  const show = this.checked;
  document.getElementById('dateFrom').style.display  = show ? '' : 'none';
  document.getElementById('dateTo').style.display    = show ? '' : 'none';
  document.getElementById('labelFrom').style.display = show ? '' : 'none';
  document.getElementById('labelTo').style.display   = show ? '' : 'none';
  applyRange();
});

(async function init() {
  try {
    allMonths = await loadManifests();
    if (allMonths.length === 0) return;

    const firstMonth = allMonths[0];
    const lastMonth  = allMonths[allMonths.length - 1];
    inpFrom.min = inpTo.min = firstMonth + '-01';
    const lastMonthDate = new Date(parseInt(lastMonth.slice(0,4)), parseInt(lastMonth.slice(5,7)), 0);
    inpFrom.max = inpTo.max = lastMonthDate.toISOString().slice(0,10);

    const today = new Date().toISOString().slice(0,10);
    let initFrom = today, initTo = today;
    if (location.hash) {
      const parts = location.hash.slice(1).split('_');
      if (parts.length === 2) { initFrom = parts[0]; initTo = parts[1]; }
    }
    if (initFrom < inpFrom.min) initFrom = inpFrom.min;
    if (initTo   > inpFrom.max) initTo   = inpFrom.max;
    inpFrom.value = initFrom;
    inpTo.value   = initTo;

    await applyRange();
  } catch(e) { /* silent fail */ }
})();

setTimeout(function() {
  const url = new URL(window.location.href);
  url.searchParams.set('_t', Date.now());
  window.location.replace(url.toString());
}, REFRESH_SEC * 1000);
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
			const safe = person.name.toLowerCase().replace(/\s+/g, "_");
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

			// Collect months present BEFORE purge
			const monthsBefore = [...new Set((fc.features || []).map(f => f.properties.date?.slice(0, 7)))].filter(
				Boolean,
			);

			const removed = this._purgeOldFeatures(fc, person.name);
			if (removed > 0) {
				await this.adapter.setStateAsync(`${ns}.${paths.allTime}`, JSON.stringify(fc), true);
				await this._writeMap(person, fc);

				// Determine which months were fully removed
				const monthsAfter = new Set(
					(fc.features || []).map(f => f.properties.date?.slice(0, 7)).filter(Boolean),
				);
				for (const ym of monthsBefore) {
					if (!monthsAfter.has(ym)) {
						await this._purgeMonthFile(safe, ym);
					} else {
						// Month partially purged – rewrite the JSON file from allTime data for that month
						const monthFeatures = (fc.features || []).filter(f => f.properties.date?.startsWith(ym));
						const monthFC = { type: "FeatureCollection", features: monthFeatures };
						const filePath = this._getMonthFilePath(safe, ym.slice(0, 4), ym.slice(5, 7));
						await new Promise(resolve => {
							this.adapter.writeFile(ns, filePath, JSON.stringify(monthFC), () => resolve());
						});
					}
				}

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
	 * Deletes a monthly JSON file and removes it from the manifest.
	 *
	 * @param {string} safe - Safe name
	 * @param {string} yearMonth - "YYYY-MM"
	 * @returns {Promise<void>}
	 */
	async _purgeMonthFile(safe, yearMonth) {
		const ns = this.config.namespace;
		const filePath = this._getMonthFilePath(safe, yearMonth.slice(0, 4), yearMonth.slice(5, 7));
		await new Promise(resolve => {
			this.adapter.unlink(ns, filePath, () => resolve());
		});
		await this._removeFromManifest(safe, yearMonth);
		this.adapter.log.info(`[Tracker:${safe}] Deleted month file ${yearMonth}`);
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
	 * @returns {{geojson:string, allTime:string, url:string, filePath:string, manifestPath:string, monthFilePath:string}} Object with relative state paths and HTML file path
	 */
	_getPaths(name) {
		const now = new Date();
		const year = String(now.getFullYear());
		const month = String(now.getMonth() + 1).padStart(2, "0");
		const safe = name.toLowerCase().replace(/\s+/g, "_");
		const base = `tracker.${safe}.currentYear.${month}`;
		return {
			geojson: `${base}.geojson`,
			allTime: `tracker.${safe}.allTime.geojson`,
			url: `tracker.${safe}.url`,
			filePath: `tracker/${safe}.html`,
			manifestPath: `tracker/${safe}/manifest.json`,
			monthFilePath: `tracker/${safe}/${year}-${month}.json`,
		};
	}

	/**
	 * Returns the file path for a specific year-month combination
	 *
	 * @param {string} safe - Safe name (lowercase, underscores)
	 * @param {string} year - 4-digit year
	 * @param {string} month - 2-digit month
	 * @returns {string} Relative file path for the monthly JSON
	 */
	_getMonthFilePath(safe, year, month) {
		return `tracker/${safe}/${year}-${month}.json`;
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
