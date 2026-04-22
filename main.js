"use strict";

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require("@iobroker/adapter-core");

const life360Connector = require("./lib/life360CloudConnector");
const life360DbConnector = require("./lib/life360DbConnector");

class Life360 extends utils.Adapter {
	constructor(options = {}) {
		super(Object.assign({ name: "life360ng" }, options));
		this.on("ready", this.onReady.bind(this));
		this.on("unload", this.onUnload.bind(this));
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {
		// Initialize your adapter here
		life360Connector.setAdapter(this); //  Sets the adapter instance for the Life360 connector
		life360DbConnector.setAdapter(this);

		// Setup polling Life360 cloud data
		life360Connector.setupPolling(function (err, cloud_data) {
			if (!err) {
				//  Pass the retrieved Life360 cloud data to the DB connector.
				life360DbConnector.publishCloudData(err, cloud_data);
			}
		});
	}

	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 *
	 * @param {() => void} callback
	 */
	onUnload(callback) {
		try {
			life360Connector.disablePolling();
			life360Connector.disconnect();
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
