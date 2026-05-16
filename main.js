"use strict";

const utils = require("@iobroker/adapter-core");

const life360Connector = require("./lib/life360CloudConnector");
const life360DbConnector = require("./lib/life360DbConnector");
const Life360Tracker = require("./lib/life360Tracker"); // ← NEU

class Life360 extends utils.Adapter {
	constructor(options = {}) {
		super(Object.assign({ name: "life360ng" }, options));
		this.on("ready", this.onReady.bind(this));
		this.on("stateChange", this.onStateChange.bind(this)); // ← NEU
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

		life360Connector.setupPolling(function (err, cloud_data) {
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
		// ← NEU
		if (this.tracker) {
			await this.tracker.onStateChange(id, state);
		}
	}

	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 *
	 * @param {() => void} callback
	 */
	onUnload(callback) {
		try {
			this.tracker?.stop(); // ← NEU
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
