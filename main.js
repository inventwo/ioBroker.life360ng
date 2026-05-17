"use strict";

const utils = require("@iobroker/adapter-core");

const life360Connector = require("./lib/life360CloudConnector");
const life360DbConnector = require("./lib/life360DbConnector");
const Life360Tracker = require("./lib/life360Tracker"); // ← NEU

class Life360 extends utils.Adapter {
	constructor(options = {}) {
		super(Object.assign({ name: "life360ng" }, options));
		this._isUnloading = false;
		this.on("ready", this.onReady.bind(this));
		this.on("stateChange", this.onStateChange.bind(this));
		this.on("message", this.onMessage.bind(this));
		this.on("unload", this.onUnload.bind(this));
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {
		life360Connector.setAdapter(this);
		life360DbConnector.setAdapter(this);

		// Tracker initialisieren ← NEU
		this.tracker = new Life360Tracker(this);
		await this.tracker.init();

		await life360DbConnector.syncNotifyPeople();
		await life360DbConnector.initNotificationBaselines();

		life360Connector.setupPolling((err, cloud_data) => {
			if (this._isUnloading) {
				return;
			}
			if (!err) {
				life360DbConnector.publishCloudData(err, cloud_data);
			}
		});
	}

	/**
	 * Is called when a subscribed state changes
	 *
	 * @param {string} id
	 * @param {ioBroker.State | null | undefined} state
	 */
	async onStateChange(id, state) {
		if (this._isUnloading || !this.tracker) {
			return;
		}
		try {
			await this.tracker.onStateChange(id, state);
		} catch (e) {
			if (!String(e?.message).includes("DB closed") && !String(e?.message).includes("Connection is closed")) {
				this.log.error(`[Tracker] onStateChange error: ${e.message}`);
			}
		}
	}

	/**
	 * Handles messages sent from the admin UI (e.g. test buttons).
	 *
	 * @param {ioBroker.Message} obj
	 */
	async onMessage(obj) {
		if (!obj || !obj.command) {
			return;
		}
		if (obj.command === "testTelegram") {
			const result = await life360DbConnector.sendTestTelegram();
			if (obj.callback) {
				this.sendTo(obj.from, obj.command, result, obj.callback);
			}
		} else if (obj.command === "testAlexa") {
			const result = await life360DbConnector.sendTestAlexa();
			if (obj.callback) {
				this.sendTo(obj.from, obj.command, result, obj.callback);
			}
		} else if (obj.command === "getPlacesList") {
			if (obj.callback) {
				this.sendTo(obj.from, obj.command, life360DbConnector.getPlacesList(), obj.callback);
			}
		} else if (obj.command === "getPersonsList") {
			if (obj.callback) {
				this.sendTo(obj.from, obj.command, life360DbConnector.getPersonsList(), obj.callback);
			}
		}
	}

	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 *
	 * @param {() => void} callback
	 */
	onUnload(callback) {
		this._isUnloading = true;
		try {
			this.tracker?.stop();
			life360Connector.disablePolling();
			life360Connector.disconnect();
			life360DbConnector.clearTimers();
			this.setState("info.connection", false, true);
			this.log.info("cleaned everything up...");
			callback();
		} catch {
			callback();
		}
	}
}

if (require.main !== module) {
	module.exports = options => new Life360(options);
} else {
	new Life360();
}
