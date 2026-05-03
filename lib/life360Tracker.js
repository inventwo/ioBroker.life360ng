"use strict";

const TrackerPersonHtml = require("./life360TrackerPerson");
const TrackerCircleHtml = require("./life360TrackerCircle");

/**
 * Life360 Tracker - Route logger module
 * Records GPS routes as GeoJSON and generates HTML maps
 *
 * GeoJSON structure:
 *   allTime.geojson  → FeatureCollection with ALL features across all months (used for HTML map)
 *   currentYear.MM.geojson → FeatureCollection for the current month (backup, per-month access)
 *
 * Each Feature = one day LineString, coordinates: [longitude, latitude, timestamp]
 *
 * Runtime config states (writable, override adapter.config):
 *   tracker.config.enabled
 *   tracker.config.minDistance
 *   tracker.config.color.pageBg / headerBg / headerBorder / headerText / routeWeight / routeOpacity
 */
class Tracker {
	/**
	 * @param {import("../main")} adapter - ioBroker adapter instance
	 */
	constructor(adapter) {
		this.adapter = adapter;
		this.config = {};
		this.subscriptions = [];
		/** UUID-based mapping: latState-ID → person object */
		this.latStateMap = {};
		/** Relative IDs of tracker.config.* states for onStateChange routing */
		this.configStateIds = new Set();
		/** Last date on which retention purge was executed (YYYY-MM-DD) */
		this.lastPurgeDate = null;
	}

	// ─────────────────────────────────────────────────────────────────────────
	// PUBLIC
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Initializes the tracker
	 *
	 * @returns {Promise<void>}
	 */
	async init() {
		this._loadConfig();
		this._initHtmlGenerators();

		await this._ensureConfigStates();
		await this._loadConfigFromStates();

		if (!this.config.enabled) {
			this.adapter.log.info("Tracker Route logger disabled");
			return;
		}

		await this._syncPeople();

		const activePeople = this.config.people.filter(p => p.enabled);
		if (activePeople.length === 0) {
			this.adapter.log.info("Tracker No persons enabled");
			return;
		}

		for (const person of activePeople) {
			await this._initPerson(person);
		}

		const familyPeople = activePeople.filter(p => p.familyMap);
		if (familyPeople.length > 0) {
			await this._ensureChannels(this.config.familyName);
			await this._updateFamilyMap();
		}

		if (this.config.retentionDays > 0) {
			await this._dailyPurgeAll();
			this.lastPurgeDate = new Date().toISOString().slice(0, 10);
		}

		const peopleWithClearFlag = this.config.people.filter(p => p.clearRecordings);
		if (peopleWithClearFlag.length > 0) {
			await this._clearAllRecordings(peopleWithClearFlag);
			const resetPeople = this.config.people.map(p => ({ ...p, clearRecordings: false }));
			this.config.people = resetPeople;
			await this.adapter.updateConfig({ trackerpeople: resetPeople });
		}

		this.adapter.log.info(`Tracker Initialized ${activePeople.length} persons`);
	}

	/**
	 * Stops the tracker and cleans up subscriptions
	 *
	 * @returns {void}
	 */
	stop() {
		for (const sub of this.subscriptions) {
			this.adapter.unsubscribeForeignStates(sub);
		}
		for (const id of this.configStateIds) {
			this.adapter.unsubscribeStates(id);
		}
		this.subscriptions = [];
		this.latStateMap = {};
		this.configStateIds = new Set();
		this.adapter.log.info("Tracker Stopped");
	}

	// ─────────────────────────────────────────────────────────────────────────
	// CONFIG
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Loads the base configuration from adapter.config (no state reads here)
	 *
	 * @returns {void}
	 */
	_loadConfig() {
		const c = this.adapter.config;
		this.config = {
			enabled: c.trackerenabled ?? false,
			minDistance: c.trackermindistance ?? 20,
			pollInterval: (() => {
				const pi = Number(c.life360pollinginterval ?? 60);
				return pi > 3600 ? Math.round(pi / 1000) : pi;
			})(),
			namespace: this.adapter.namespace,
			people: c.trackerpeople,
			familyName: c.trackerfamilyname || "circle".toLowerCase().replace(/\s+/g, "_"),
			mapColors: {
				pageBg: c.trackercolorpagebg || "#1a1a2e",
				headerBg: c.trackercolorheaderbg || "#16213e",
				headerBorder: c.trackercolorheaderborder || "#0f3460",
				headerText: c.trackercolorheadertext || "#aaaaaa",
				routeWeight: c.trackerrouteweight ?? 4,
				routeOpacity: c.trackerrouteopacity ?? 0.85,
				markerOpacity: c.trackermarkeropacity ?? 1,
				markerSize: c.trackermarkersize ?? 1,
				legendEnabled: c.trackermaplegend ?? true,
			},
			familyRoutesEnabled: c.trackerfamilyroutesenabled ?? true,
			familyMapHeaderName: c.familymapheadername,
			retentionDays: c.trackerretentiondays ?? 0,
		};
	}

	/**
	 * Creates the HTML generator instances. Must be called after _loadConfig().
	 *
	 * @returns {void}
	 */
	_initHtmlGenerators() {
		this._personHtml = new TrackerPersonHtml(this.config);
		this._circleHtml = new TrackerCircleHtml(this.config, this.adapter);
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
	 *
	 * @returns {Promise<void>}
	 */
	async _ensureConfigStates() {
		const ns = this.config.namespace;
		await this.adapter.setObjectNotExistsAsync(`${ns}.tracker`, {
			type: "device",
			common: { name: "Tracker Route logger" },
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
				await this.adapter.setObjectAsync(fullId, { type: "state", common: { ...def.meta }, native: {} });
				this.adapter.log.debug(`Tracker Config state created ${def.id}`);
			}
			await this.adapter.setStateAsync(fullId, def.value, true);
			this.adapter.log.debug(`Tracker Config state synced ${def.id} = ${def.value}`);
			this.adapter.subscribeStates(def.id);
			this.configStateIds.add(def.id);
		}
	}

	/**
	 * Reads all tracker.config.* states and merges them into this.config.
	 *
	 * @returns {Promise<void>}
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
			this.adapter.log.debug(`Tracker Config loaded from states enabled=${this.config.enabled}`);
		}
	}

	/**
	 * Applies a single tracker.config.* state change at runtime.
	 *
	 * @param {string} shortId
	 * @param {any} val
	 * @returns {Promise<void>}
	 */
	async _applyConfigStateChange(shortId, val) {
		this.adapter.log.info(`Tracker Config state changed ${shortId} = ${val}`);
		switch (shortId) {
			case "tracker.config.enabled":
				this.config.enabled = !!val;
				if (!this.config.enabled) {
					this.adapter.log.info("Tracker Route logger disabled. Restart adapter to reactivate.");
				} else {
					this.adapter.log.info("Tracker Route logger enabled. Restart the adapter to start tracking.");
				}
				return;
			default:
				return;
		}
	}

	/**
	 * Re-renders all active person maps and the family map.
	 * Called when a map color setting changes at runtime.
	 *
	 * @returns {Promise<void>}
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
				this.adapter.log.warn(`Tracker${person.name} Re-render error: ${e.message}`);
			}
		}
		const familyPeople = activePeople.filter(p => p.familyMap);
		if (familyPeople.length > 0) {
			await this._updateFamilyMap();
		}
		this.adapter.log.debug("Tracker All maps re-rendered after color config change");
	}

	// ─────────────────────────────────────────────────────────────────────────
	// PERSON SYNC
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Synchronizes persons from Life360 with the adapter config
	 *
	 * @returns {Promise<void>}
	 */
	async _syncPeople() {
		const objects = await this.adapter.getObjectViewAsync("system", "channel", {
			startkey: `${this.config.namespace}.people.`,
			endkey: `${this.config.namespace}.people.\u9999`,
		});
		const knownNames = objects.rows.map(r => r.value?.common?.name).filter(Boolean);
		const defaultColors = ["#4a90e2", "#e94560", "#4caf50", "#ff9800", "#9c27b0", "#00bcd4"];
		const people = [...this.config.people];
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
				this.adapter.log.info(`Tracker New person found: ${name}`);
			}
		}
		if (changed) {
			this.config.people = people;
			await this.adapter.updateConfig({ trackerpeople: people });
		}
	}

	// ─────────────────────────────────────────────────────────────────────────
	// CHANNEL STRUCTURE
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Creates the object structure for a person or family identifier
	 *
	 * @param {string} name
	 * @returns {Promise<void>}
	 */
	async _ensureChannels(name) {
		const ns = this.config.namespace;
		const month = String(new Date().getMonth() + 1).padStart(2, "0");
		const safe = name.toLowerCase().replace(/\s+/g, "_");

		await this.adapter.extendObjectAsync(ns, {
			type: "meta",
			common: { name: "User files for life360ng", type: "meta.user" },
			native: {},
		});
		await this.adapter.setObjectNotExistsAsync(`${ns}.tracker`, {
			type: "device",
			common: { name: "Tracker Route logger" },
			native: {},
		});
		await this.adapter.setObjectNotExistsAsync(`${ns}.tracker.${safe}`, {
			type: "channel",
			common: { name },
			native: {},
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

	// ─────────────────────────────────────────────────────────────────────────
	// INITIALIZE PERSON
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Initializes tracking for a person
	 *
	 * @param {{name:string, color:string, enabled:boolean, ownMap:boolean, familyMap:boolean}} person
	 * @returns {Promise<void>}
	 */
	async _initPerson(person) {
		await this._ensureChannels(person.name);
		const paths = this._getPaths(person.name);
		const personId = await this._resolvePersonId(person.name);

		await this._ensureState(paths.url, this._buildUrl(person), {
			name: `${person.name} - Map URL`,
			type: "string",
			role: "url",
			read: true,
			write: false,
		});

		const latState = await this.adapter.getForeignStateAsync(
			`${this.config.namespace}.people.${personId}.latitude`,
		);
		const longState = await this.adapter.getForeignStateAsync(
			`${this.config.namespace}.people.${personId}.longitude`,
		);

		// allTime state
		const existingAllTime = await this.adapter.getStateAsync(`${this.config.namespace}.${paths.allTime}`);
		let allTimeFC;
		if (!existingAllTime || existingAllTime.val === null) {
			allTimeFC = this._emptyFeatureCollection();
			if (latState?.val != null && longState?.val != null) {
				this._addPointToFC(allTimeFC, longState.val, latState.val, latState.ts || Date.now());
				this.adapter.log.debug(`Tracker${person.name} Seeded allTime with current location`);
			}
		} else {
			try {
				allTimeFC = JSON.parse(existingAllTime.val);
				const today = new Date().toISOString().slice(0, 10);
				if (
					!allTimeFC.features.find(f => f.properties.date === today) &&
					latState?.val != null &&
					longState?.val != null
				) {
					this._addPointToFC(allTimeFC, longState.val, latState.val, latState.ts || Date.now());
					this.adapter.log.debug(`Tracker${person.name} Seeded today's feature with current location`);
				}
			} catch (e) {
				this.adapter.log.warn(`Tracker${person.name} allTime parse error: ${e.message}`);
				allTimeFC = this._emptyFeatureCollection();
			}
		}

		await this._ensureState(paths.allTime, JSON.stringify(allTimeFC), {
			name: `GeoJSON ${person.name} all time`,
			type: "string",
			role: "json",
			read: true,
			write: false,
		});

		// Monthly state
		const existingMonth = await this.adapter.getStateAsync(`${this.config.namespace}.${paths.geojson}`);
		if (!existingMonth || existingMonth.val === null) {
			const monthFC = this._emptyFeatureCollection();
			if (latState?.val != null && longState?.val != null) {
				this._addPointToFC(monthFC, longState.val, latState.val, latState.ts || Date.now());
			}
			await this._ensureState(paths.geojson, JSON.stringify(monthFC), {
				name: `GeoJSON ${person.name}`,
				type: "string",
				role: "json",
				read: true,
				write: false,
			});
		}

		await this._writeMap(person, allTimeFC);

		const latId = `${this.config.namespace}.people.${personId}.latitude`;
		if (!this.subscriptions.includes(latId)) {
			this.adapter.subscribeForeignStates(latId);
			this.subscriptions.push(latId);
		}
		this.latStateMap[latId] = person;
		this.adapter.log.debug(`Tracker${person.name} Initialized latId=${latId}`);
	}

	// ─────────────────────────────────────────────────────────────────────────
	// STATE CHANGE HANDLER
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Handles state changes – call from main.js
	 *
	 * @param {string} id
	 * @param {ioBroker.State|null|undefined} state
	 * @returns {Promise<void>}
	 */
	async onStateChange(id, state) {
		if (!state) {
			return;
		}

		const shortId = id.startsWith(`${this.config.namespace}.`) ? id.slice(this.config.namespace.length + 1) : null;
		if (shortId && this.configStateIds.has(shortId)) {
			if (state.ack === false) {
				await this._applyConfigStateChange(shortId, state.val);
			}
			return;
		}

		if (state.ack === false) {
			return;
		}

		const person = this.latStateMap[id];
		if (!person) {
			return;
		}

		const lat = state.val;
		if (lat === null) {
			return;
		}

		const personId = await this._resolvePersonId(person.name);
		const longState = await this.adapter.getForeignStateAsync(
			`${this.config.namespace}.people.${personId}.longitude`,
		);
		const long = longState?.val;
		if (long === null) {
			return;
		}

		const paths = this._getPaths(person.name);
		const ns = this.config.namespace;

		let allTimeFC;
		const existingAllTime = await this.adapter.getStateAsync(`${ns}.${paths.allTime}`);
		if (!existingAllTime || existingAllTime.val === null) {
			allTimeFC = this._emptyFeatureCollection();
		} else {
			try {
				allTimeFC = JSON.parse(existingAllTime.val);
			} catch (e) {
				this.adapter.log.warn(`Tracker${person.name} allTime parse error: ${e.message}`);
				allTimeFC = this._emptyFeatureCollection();
			}
		}

		if (!this._shouldUpdate(allTimeFC, lat, long)) {
			return;
		}

		const ts = Date.now();
		this._addPointToFC(allTimeFC, long, lat, ts);
		await this.adapter.setStateAsync(`${ns}.${paths.allTime}`, JSON.stringify(allTimeFC), true);

		let monthFC;
		const existingMonth = await this.adapter.getStateAsync(`${ns}.${paths.geojson}`);
		if (!existingMonth || existingMonth.val === null) {
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
				this.adapter.log.warn(`Tracker${person.name} monthly GeoJSON parse error: ${e.message}`);
				monthFC = this._emptyFeatureCollection();
			}
			this._addPointToFC(monthFC, long, lat, ts);
			await this.adapter.setStateAsync(`${ns}.${paths.geojson}`, JSON.stringify(monthFC), true);
		}

		const today = new Date().toISOString().slice(0, 10);
		if (this.config.retentionDays > 0 && this.lastPurgeDate !== today && this.lastPurgeDate !== null) {
			this.lastPurgeDate = today;
			await this._dailyPurgeAll();
			const purgedState = await this.adapter.getStateAsync(`${ns}.${paths.allTime}`);
			if (purgedState?.val) {
				try {
					allTimeFC = JSON.parse(purgedState.val);
				} catch {
					/* keep existing */
				}
			}
		}

		await this._writeMap(person, allTimeFC);
		if (person.familyMap) {
			await this._updateFamilyMap();
		}
	}

	// ─────────────────────────────────────────────────────────────────────────
	// FAMILY MAP
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Updates the combined family map
	 *
	 * @returns {Promise<void>}
	 */
	async _updateFamilyMap() {
		const ns = this.config.namespace;
		const activePeople = this.config.people.filter(p => p.enabled && p.familyMap);
		if (activePeople.length === 0) {
			return;
		}

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
				for (const f of fc.features) {
					f.properties.color = f.properties.color || person.color;
					f.properties.name = f.properties.name || person.name;
				}
				personFCs.push({ person: { ...person, circleId: person.circleId || this.config.circleId }, fc });
			} catch (e) {
				this.adapter.log.warn(`Trackercircle Parse error for ${person.name}: ${e.message}`);
			}

			const existingMonth = await this.adapter.getStateAsync(`${ns}.${paths.geojson}`);
			if (existingMonth?.val) {
				try {
					const monthFC = JSON.parse(existingMonth.val);
					for (const f of monthFC.features) {
						f.properties.color = f.properties.color || person.color;
						f.properties.name = f.properties.name || person.name;
					}
					personMonthFCs.push(...monthFC.features);
				} catch (e) {
					this.adapter.log.warn(`Trackercircle Monthly parse error for ${person.name}: ${e.message}`);
				}
			}
		}

		if (personFCs.length === 0) {
			return;
		}

		const familyFC = { type: "FeatureCollection", features: personFCs.flatMap(({ fc }) => fc.features) };
		const familyMonthFC = { type: "FeatureCollection", features: personMonthFCs };

		await this._ensureChannels(this.config.familyName);
		const familyPaths = this._getPaths(this.config.familyName);

		await this._ensureState(familyPaths.allTime, JSON.stringify(familyFC), {
			name: "GeoJSON Family all time",
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

		const html = await this._circleHtml.generate(personFCs);

		await new Promise((resolve, reject) => {
			this.adapter.writeFile(ns, familyPaths.filePath, html, async err => {
				if (err) {
					this.adapter.log.error(`Trackercircle writeFile error: ${err}`);
					reject(err);
				} else {
					const sizeKB = Math.round((Buffer.byteLength(html, "utf8") / 1024) * 100) / 100;
					await this.adapter.setStateAsync(`${ns}.tracker.${this.config.familyName}.mapSize`, {
						val: sizeKB,
						ack: true,
					});
					resolve();
				}
			});
		});
		this.adapter.log.debug("Trackercircle Circle map updated");
	}

	// ─────────────────────────────────────────────────────────────────────────
	// HTML – SINGLE MAP
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Writes the HTML map file for a single person
	 *
	 * @param {{name:string, color:string}} person
	 * @param {object} fc - FeatureCollection (allTime)
	 * @returns {Promise<void>}
	 */
	_writeMap(person, fc) {
		const html = String(this._personHtml.generate(person, fc, person.ownMap !== false));
		const paths = this._getPaths(person.name);
		return new Promise((resolve, reject) => {
			this.adapter.writeFile(this.config.namespace, paths.filePath, html, async err => {
				if (err) {
					this.adapter.log.error(`Tracker${person.name} writeFile error: ${err}`);
					reject(err);
				} else {
					const sizeKB = Math.round((Buffer.byteLength(html, "utf8") / 1024) * 100) / 100;
					const safe = person.name.toLowerCase().replace(/\s+/g, "_");
					await this.adapter.setStateAsync(`${this.config.namespace}.tracker.${safe}.mapSize`, {
						val: sizeKB,
						ack: true,
					});
					const total = (fc.features || []).reduce((s, f) => s + (f.geometry?.coordinates?.length || 0), 0);
					this.adapter.log.debug(`Tracker${person.name} Map updated (${total} points)`);
					resolve();
				}
			});
		});
	}

	// ─────────────────────────────────────────────────────────────────────────
	// GEOJSON HELPERS
	// ─────────────────────────────────────────────────────────────────────────

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
				this.adapter.log.warn(`Tracker${person.name} clearAllRecordings parse error: ${e.message}`);
				continue;
			}
			const newFC = this._emptyFeatureCollection();
			const lastFeature = fc.features[fc.features.length - 1];
			if (lastFeature?.geometry?.coordinates?.length > 0) {
				const lastCoord = lastFeature.geometry.coordinates[lastFeature.geometry.coordinates.length - 1];
				this._addPointToFC(newFC, lastCoord[0], lastCoord[1], lastCoord[2] || Date.now());
			}
			await this.adapter.setStateAsync(`${ns}.${paths.allTime}`, JSON.stringify(newFC), true);
			await this._writeMap(person, newFC);
			if (person.familyMap) {
				familyNeedsUpdate = true;
			}
			this.adapter.log.info(`Tracker${person.name} All recordings cleared`);
		}
		if (familyNeedsUpdate) {
			await this._updateFamilyMap();
		}
		this.adapter.log.info("Tracker All recordings cleared successfully");
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
				this.adapter.log.warn(`Tracker${person.name} dailyPurge parse error: ${e.message}`);
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
				`Tracker${label ? `${label} ` : ""}Purged ${removed} days older than ${cutoffStr} (retentionDays=${this.config.retentionDays})`,
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
				properties: { date: today, pointCount: 0, startTime: null, endTime: null },
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

	// ─────────────────────────────────────────────────────────────────────────
	// UTILITY HELPERS
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Returns state paths for a person or the family
	 *
	 * @param {string} name - Display name or family identifier
	 * @returns {{geojson:string, allTime:string, url:string, filePath:string}} Object with relative state paths and HTML file path
	 */
	_getPaths(name) {
		const month = String(new Date().getMonth() + 1).padStart(2, "0");
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
		const safe = person.name.toLowerCase().replace(/\s+/g, "_");
		return `${this.config.namespace}/tracker/${safe}.html`;
	}

	/**
	 * Builds the URL for the family map
	 *
	 * @returns {string} Full HTTP URL to the family HTML map file
	 */
	_buildFamilyUrl() {
		return `${this.config.namespace}/tracker/${this.config.familyName}.html`;
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
			this.adapter.log.warn(`Tracker Failed to determine IP address: ${e.message}`);
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
		if (this.personIdCache && this.personIdCache[name]) {
			return this.personIdCache[name];
		}
		if (!this.personIdCache) {
			this.personIdCache = {};
		}
		const objects = await this.adapter.getObjectViewAsync("system", "channel", {
			startkey: `${this.config.namespace}.people.`,
			endkey: `${this.config.namespace}.people.\u9999`,
		});
		for (const row of objects.rows) {
			if (row.value?.common?.name === name) {
				const id = row.id.split(".people.")[1];
				this.personIdCache[name] = id;
				return id;
			}
		}
		this.adapter.log.warn(`Tracker Person not found: ${name}`);
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
			await this.adapter.setObjectAsync(fullId, { type: "state", common: { ...meta, def: value }, native: {} });
		}
		await this.adapter.setStateAsync(fullId, value, true);
	}
}

module.exports = Tracker;
