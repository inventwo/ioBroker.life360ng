"use strict";

let adapter;

//  Load core-modules ...
const https = require("node:https");

/**
 * Custom HTTPS agent with Android-like TLS cipher order to avoid Cloudflare JA3 fingerprint blocking.
 * Matches the cipher suite order used by Android 13 (Conscrypt SSL library).
 */
const tlsAgent = new https.Agent({
	keepAlive: false,
	minVersion: "TLSv1.2",
	ciphers: [
		"TLS_AES_128_GCM_SHA256",
		"TLS_AES_256_GCM_SHA384",
		"TLS_CHACHA20_POLY1305_SHA256",
		"ECDHE-ECDSA-AES128-GCM-SHA256",
		"ECDHE-ECDSA-AES256-GCM-SHA384",
		"ECDHE-ECDSA-CHACHA20-POLY1305",
		"ECDHE-RSA-AES128-GCM-SHA256",
		"ECDHE-RSA-AES256-GCM-SHA384",
		"ECDHE-RSA-CHACHA20-POLY1305",
	].join(":"),
});

/**
 * Makes an HTTPS request using the custom TLS agent.
 *
 * @param {{url: string, method?: string, headers?: object, form?: object, agent?: object}} options Request options.
 * @returns {Promise<{statusCode: number, body: any}>} Response with parsed JSON body.
 */
function httpsRequest(options) {
	return new Promise((resolve, reject) => {
		const parsedUrl = new URL(options.url);
		const method = options.method || "GET";
		const headers = { ...options.headers };
		let postData = null;

		if (options.form) {
			postData = new URLSearchParams(options.form).toString();
			headers["Content-Type"] = "application/x-www-form-urlencoded";
			headers["Content-Length"] = Buffer.byteLength(postData);
		}

		const reqOptions = {
			hostname: parsedUrl.hostname,
			path: parsedUrl.pathname + (parsedUrl.search || ""),
			method,
			headers,
			agent: options.agent || tlsAgent,
		};

		const req = https.request(reqOptions, res => {
			let data = "";
			res.on("data", chunk => {
				data += chunk;
			});
			res.on("end", () => {
				let body;
				try {
					body = JSON.parse(data);
				} catch {
					body = data;
				}
				resolve({ statusCode: res.statusCode, body });
			});
		});

		req.on("error", reject);

		if (postData) {
			req.write(postData);
		}

		req.end();
	});
}

//  ioBroker specific modules
const iobHelpers = require("./iobHelpers");
const myLogger = new iobHelpers.IobLogger(adapter);

/**
 * Hard-coded "CLIENT_SECRET": Has to be identified and verified after Life360 publishes a new version of the mobile app!
 */
const LIFE360_CLIENT_SECRET =
	"Y2F0aGFwYWNyQVBoZUtVc3RlOGV2ZXZldnVjSGFmZVRydVl1ZnJhYzpkOEM5ZVlVdkE2dUZ1YnJ1SmVnZXRyZVZ1dFJlQ1JVWQ==";
const DEFAULT_USER_AGENT = "com.life360.android.safetymapd/KOKO/23.50.0 android/13";

/**
 * The Life360 API URIs.
 * - login URL
 * - circles URL
 */
const LIFE360_URL = {
	login: "https://api-cloudfront.life360.com/v3/oauth2/token",
	circles: "https://api-cloudfront.life360.com/v4/circles",
	circlesV3: "https://api-cloudfront.life360.com/v3/circles",
};

const min_polling_interval = 15; //  Min polling interval in seconds
const maxAgeToken = 300; //  Max age of the Life360 token in seconds
let objTimeoutConnection = null; //  Connection Timeout id
let objIntervalPoll = null; //  Poll Interval id
let countOnlineOperations = 0; //  How many online operations are running?
let adapterConnectionState = false; //  Life360 connection status.
const Life360APIDataMaxRetries = 2; //  Max retries to poll data from the Life360 API if the API does not throw an error.
const Life360RetryDelay = 5000; //  Delay in ms between login retries (to avoid Cloudflare rate limiting)

let life360_username = process.env.LIFE360_USERNAME;
let life360_token = process.env.LIFE360_TOKEN;

const userAgent = DEFAULT_USER_AGENT;

/**
 * Stores authentication information for the current session.
 * - access token
 * - type of token
 */
let auth = {
	access_token: null,
	token_type: null,
};

/**
 * Stores the data retrieved from Life360 cloud services.
 */
let cloud_data = {
	circles: [],
};

/**
 * Returns the number of pending online operations against Life360 cloud services.
 */
function getCurrentOnlineOperations() {
	return countOnlineOperations;
}

/**
 * Notify the Life360 cloud connector about starting a new online operation.
 */
function startOnlineOperation() {
	countOnlineOperations += 1;
	logger("silly", `Current online operations: ${countOnlineOperations}.`);
	return countOnlineOperations;
}

/**
 * Notify the Life360 cloud connector about finished an online operation.
 */
function stopOnlineOperation() {
	countOnlineOperations -= 1;
	if (countOnlineOperations < 0) {
		countOnlineOperations = 0;
	}
	logger("silly", `Current online operations: ${countOnlineOperations}.`);
	return countOnlineOperations;
}

/**
 * Simple sleep function.
 *
 * @param {number} milliseconds Time to sleep (ms.).
 */
function Sleep(milliseconds) {
	return new Promise(resolve => setTimeout(resolve, milliseconds));
}

/**
 * Logger is a wrapper for logging.
 *
 * @param {*} level Set to "error", "warn", "info", "debug"
 * @param {*} message The message to log
 */
function logger(level, message) {
	myLogger.logger(level, message);
}

/**
 * Updates the Life360 connector's state for the ioBroker instance.
 *
 * @param {boolean} isConnected Set to true if connected.
 */
function setAdapterConnectionState(isConnected) {
	if (!adapter) {
		//  No adapter instance set.
	} else {
		// Issue #9: check Adapter with js-controller 3.0.x
		adapter.setState("info.connection", isConnected, true);
		if (isConnected != adapterConnectionState) {
			if (isConnected) {
				myLogger.info("Connected to Life360 cloud services.");
			} else {
				myLogger.info("Disconnected from Life360 cloud services.");
			}
		}
		adapterConnectionState = isConnected;
	}
}

/**
 * Set ioBroker adapter instance for the connector
 *
 *  @param {*} adapter_in The adapter instance for this connector.
 */
exports.setAdapter = function (adapter_in) {
	adapter = adapter_in;
	myLogger.setAdapter(adapter);

	life360_username = adapter.config.life360_username;
	life360_token = adapter.config.life360_token;
};

/**
 * Connect to the Life360 service.
 * Specify a username OR both a phone number and country code.
 *
 * @param {*} username Life360 username.
 */
exports.connectLife360 = function (username) {
	return new Promise((resolve, reject) => {
		if (!username || typeof username === "function") {
			username = life360_username;
		}

		//  If a Bearer token is configured, use it directly (no password login needed)
		if (life360_token) {
			logger("debug", "Using configured Bearer token for Life360 authentication.");
			auth = {
				access_token: life360_token,
				token_type: "Bearer",
			};
			resolve(auth);
			return;
		}

		logger("debug", "Connecting to Life360 service  ...");

		auth = {
			access_token: null,
			token_type: null,
		};

		username = typeof username !== "undefined" ? username : "";

		const formData = {
			grant_type: "password",
			username: username,
		};

		const options = {
			url: LIFE360_URL.login,
			method: "POST",
			agent: tlsAgent,
			headers: {
				Authorization: `Basic ${LIFE360_CLIENT_SECRET}`,
				Accept: "application/json",
				"User-Agent": userAgent,
				"Cache-Control": "no-cache",
			},
			form: formData,
		};

		httpsRequest(options)
			.then(response => {
				let body;
				try {
					body = typeof response.body === "string" ? JSON.parse(response.body) : response.body;
				} catch {
					logger(
						"error",
						`Life360 login failed - HTTP ${response.statusCode}, body: ${String(response.body).substring(0, 300)}`,
					);
					reject(new Error("Life360 login: invalid JSON response"));
					return;
				}
				if (response.statusCode !== 200 || !body["access_token"]) {
					auth = {
						access_token: null,
						token_type: null,
					};

					logger(
						"error",
						`Connection established but failed to authenticate. HTTP ${response.statusCode}, response: ${JSON.stringify(body)}`,
					);
					logger("debug", "Auth tokens deleted.");

					reject(new Error("Connection established but failed to authenticate. Check your credentials!"));
				} else {
					auth = {
						access_token: body["access_token"],
						token_type: body["token_type"],
					};

					logger("debug", `Logged in as user: ${username}.`);
					logger("debug", "Saved auth tokens.");

					resolve(auth);
				}
			})
			.catch(err => {
				setAdapterConnectionState(false);
				reject(new Error(`Unable to connect: ${err}`));
			});
	});
};

/**
 * Ensures connection to the Life360 service.
 */
exports.connect = function () {
	return new Promise((resolve, reject) => {
		if (!exports.is_connected()) {
			logger("debug", "Not authenticated against Life360. Will try to connect ...");

			exports
				.connectLife360(null)
				.then(auth_new => {
					auth = auth_new;

					//  Set timeout to remove auth tokens
					objTimeoutConnection = setTimeout(
						() => {
							exports.disconnect();
						},
						(maxAgeToken / 3) * 2 * 1000,
					);

					setAdapterConnectionState(true);

					resolve(auth);
				})
				.catch(err => {
					exports.disconnect();
					setAdapterConnectionState(false);
					reject(new Error(err));
				});
		} else {
			resolve(auth);
		}
	});
};

/**
 * Disconnect from Life360 (i.e. clear all tokens)
 */
exports.disconnect = async function () {
	clearTimeout(objTimeoutConnection);

	if (getCurrentOnlineOperations() > 0) {
		logger("info", "Waiting for online operations to finish ...");
		while (getCurrentOnlineOperations() != 0) {
			await Sleep(1000);
			logger("silly", `  - Pending operations: ${getCurrentOnlineOperations()}.`);
		}
	}

	auth = {
		access_token: null,
		token_type: null,
	};

	logger("debug", "Auth tokens deleted.");
	// logger("info", "Disconnected from Life360.");
};

/**
 * Returns true if connected to Life360 cloud services.
 */
exports.is_connected = function () {
	return auth.access_token;
};

/**
 * Returns the authentication information for Life360.
 */
exports.get_auth = function () {
	return auth;
};

/**
 * Returns a list of the user's Life360 circles.
 *
 * @param auth_in
 */
exports.getCircles = function (auth_in) {
	return new Promise((resolve, reject) => {
		if (!auth_in) {
			auth_in = auth;
		}

		const options = {
			url: LIFE360_URL.circles,
			agent: tlsAgent,
			headers: {
				Authorization: `${auth_in.token_type} ${auth_in.access_token}`,
				Accept: "application/json",
				"User-Agent": userAgent,
				"Cache-Control": "no-cache",
			},
		};

		logger("silly", `Retrieving circles at ${LIFE360_URL.circles}`);

		httpsRequest(options)
			.then(response => {
				if (!response.body.circles) {
					logger("error", "No circles found!");
					reject(new Error("No circles found!"));
				} else {
					if (response.body.circles.length == 0) {
						logger("error", "No circles in your Life360.");
						reject(new Error("No circles in your Life360."));
					} else {
						logger("debug", "Retrieved circles.");
						resolve(response.body.circles);
					}
				}
			})
			.catch(err => {
				reject(new Error(`Unable to poll circles: ${err}`));
			});
	});
};

/**
 * Returns details for a Life360 circle identified by the the circle's id.
 *
 * @param auth_in
 * @param circleId
 */
exports.getCircleById = function (auth_in, circleId) {
	return new Promise((resolve, reject) => {
		if (!auth_in) {
			auth_in = auth;
		}

		const LIFE360_CIRCLE_URL = `${LIFE360_URL.circles}/${circleId}`;
		const options = {
			url: LIFE360_CIRCLE_URL,
			agent: tlsAgent,
			headers: {
				Authorization: `${auth_in.token_type} ${auth_in.access_token}`,
				Accept: "application/json",
				"User-Agent": userAgent,
				"Cache-Control": "no-cache",
			},
		};

		logger("silly", `Retrieving circle at ${LIFE360_CIRCLE_URL}`);

		httpsRequest(options)
			.then(response => {
				logger("silly", `Retrieved circle with id ${circleId} !`);
				resolve(response.body);
			})
			.catch(err => {
				reject(new Error(`Unable to poll circle with ID ${circleId}: ${err}`));
			});
	});
};

/**
 * Deprecated.
 *
 * @param circle_in
 */
exports.getCircleMembersPromise = function (circle_in) {
	return new Promise((resolve, reject) => {
		if (!circle_in) {
			reject(new Error("Provide a circle object, please."));
		} else {
			const members = [];

			if (circle_in.members.length == 0) {
				console.log("Circle has no members.");
			} else {
				for (let oMember in circle_in.members) {
					let member = circle_in.members[oMember];
					members.push({ id: member.id, json: member });
				}
			}

			resolve(members);
		}
	});
};

/**
 * Returns an array conaining a circle's members.
 *
 * @param circle_in
 */
exports.getCircleMembers = function (circle_in) {
	const members = [];

	if (!circle_in) {
		logger("error", "Provide a circle object, please.");
	} else {
		if (circle_in.members.length == 0) {
			logger("debug", "Circle has no members.");
		} else {
			for (let oMember in circle_in.members) {
				let member = circle_in.members[oMember];
				members.push({ id: member.id, json: member });
			}
		}
	}

	return members;
};

/**
 * Disables automatic polling.
 */
exports.disablePolling = function () {
	if (objIntervalPoll) {
		clearInterval(objIntervalPoll);
		logger("info", "Disabled polling.");
	}
};

/**
 * Enables automatic polling.
 *
 * @param callback
 */
exports.setupPolling = function (callback) {
	let polling_interval = min_polling_interval;

	if (!adapter) {
		polling_interval = Number(process.env.LIFE360_POLLING_INTERVAL);
	} else {
		polling_interval = Number(adapter.config.life360_polling_interval);
	}

	if (polling_interval < min_polling_interval) {
		logger("error", `Polling interval should be greater than ${min_polling_interval}`);

		return false;
	}
	exports.disablePolling();

	// exports.poll(callback);
	exports.pollAsync(callback);

	// Enable polling
	objIntervalPoll = setInterval(() => {
		// exports.poll(callback);
		exports.pollAsync(callback);
	}, polling_interval * 1000);

	logger("info", `Polling enabled every ${polling_interval} seconds.`);
	return true;
};

/**
 * Initiates an async Life360 cloud data poll and passes the data to a callback function.
 *
 * @param {Function} callback The callback function.
 */
exports.pollAsync = function (callback) {
	myLogger.debug("Fetching Life360 cloud data ...");
	pollLife360DataAsync()
		.then(cloud_data => {
			if (callback) {
				logger("debug", "Pushing cloud_data to callback function");
				callback(false, cloud_data);
			}
			return true;
		})
		.catch(err => {
			if (callback) {
				callback(err, null);
			} else {
				logger("error", `Error polling Life360 data: ${err}`);
			}
			return false;
		});
};

/**
 * Polls (async) the Life360 cloud data.
 */
async function pollLife360DataAsync() {
	cloud_data.circles = [];

	try {
		//  Ensure we are connected and authorized
		startOnlineOperation();
		// const auth_in = await exports.connect();
		let auth_in = false;
		let counter = 0;
		let lastError = false;

		do {
			counter++;
			logger("silly", `Ensure we are connected and authorized ... try #${counter}`);

			try {
				auth_in = await exports.connect();
			} catch (error) {
				auth_in = false;
				lastError = error;
				if (counter <= Life360APIDataMaxRetries) {
					logger("debug", `Login failed, waiting ${Life360RetryDelay / 1000}s before retry ...`);
					await Sleep(Life360RetryDelay);
				}
			}
		} while (counter <= Life360APIDataMaxRetries && !auth_in);

		if (!auth_in) {
			//  Failed to connect or to login
			logger("error", `Failed to connect or to login for ${counter} times. Aborting ...`);
			throw lastError;
		}

		//  Connected. Start polling Life360 data.

		//  First poll the user's circles.
		const circles = await exports.getCirclesAsync(auth_in);

		for (let c in circles) {
			const circle = circles[c];
			logger("silly", `circle ${circle.id} --> ${circle.name}`);

			//  Get circle's members
			const circleMembers = await exports.getCircleMembersAsync(auth_in, circle.id);
			circle.members = circleMembers;
			logger("silly", `  - ${circle.members.length} member(s) found.`);

			//  Get circle's places
			const circlePlaces = await exports.getCirclePlacesAsync(auth_in, circle.id);
			circle.places = circlePlaces;
			logger("silly", `  - ${circle.places.length} place(s) found.`);
		}

		//  Return the retrieved Life360 cloud data
		cloud_data.circles = circles;
		stopOnlineOperation();
		return cloud_data;
	} catch (error) {
		stopOnlineOperation();
		logger("error", error);
	}
}

/**
 * Returns the Life360 circles.
 *
 * @param {*} auth_in The auth object.
 */
exports.getCirclesAsync = async function (auth_in) {
	if (!auth_in) {
		auth_in = auth;
	}

	const options = {
		url: LIFE360_URL.circles,
		agent: tlsAgent,
		headers: {
			Authorization: `${auth_in.token_type} ${auth_in.access_token}`,
			Accept: "application/json",
			"User-Agent": userAgent,
			"Cache-Control": "no-cache",
		},
	};

	logger("silly", `Async - Retrieving circles at ${LIFE360_URL.circles}`);

	try {
		startOnlineOperation();

		let obj = undefined;

		let counter = 0;

		do {
			counter++;
			if (counter > 1) {
				logger("debug", `Polling Life360 circles... try #${counter}`);
			}

			const response = await httpsRequest(options);
			logger("silly", `Retrieved ${response.body.circles.length} circle(s).`);
			obj = response.body.circles;
		} while (counter <= Life360APIDataMaxRetries && obj === undefined);

		if (obj === undefined) {
			logger("warn", "Life360 circle data expected but missing!");
			obj = [];
		}

		stopOnlineOperation();
		return obj;
	} catch (error) {
		logger("error", `Failed to retrieve members: ${error}`);
		stopOnlineOperation();
	}
};

/**
 * Returns the Life360 circle's members.
 *
 * @param {*} auth_in The auth object.
 * @param {*} circleId The id of a Life360 circle.
 */
exports.getCircleMembersAsync = async function (auth_in, circleId) {
	if (!auth_in) {
		auth_in = auth;
	}

	const URL = `${LIFE360_URL.circlesV3}/${circleId}/members`;
	const options = {
		url: URL,
		agent: tlsAgent,
		headers: {
			Authorization: `${auth_in.token_type} ${auth_in.access_token}`,
			Accept: "application/json",
			"User-Agent": userAgent,
			"Cache-Control": "no-cache",
		},
	};

	logger("silly", `Retrieving members at ${URL}`);

	try {
		startOnlineOperation();

		let obj = undefined;

		let counter = 0;

		do {
			counter++;
			if (counter > 1) {
				logger("debug", `Polling Life360 members ... try #${counter}`);
			}

			const response = await httpsRequest(options);
			logger("silly", `Retrieved ${response.body.members.length} member(s).`);
			obj = response.body.members;
		} while (counter <= Life360APIDataMaxRetries && obj === undefined);

		if (obj === undefined) {
			logger("warn", "Life360 member data expected but missing!");
			obj = [];
		}

		stopOnlineOperation();
		return obj;
	} catch (error) {
		logger("error", `Failed to retrieve members: ${error}`);
		stopOnlineOperation();
	}
};

/**
 * Returns the Life360 circle's places.
 *
 * @param {*} auth_in The auth object.
 * @param {*} circleId The id of a Life360 circle.
 */
exports.getCirclePlacesAsync = async function (auth_in, circleId) {
	if (!auth_in) {
		auth_in = auth;
	}

	const URL = `${LIFE360_URL.circlesV3}/${circleId}/places`;
	const options = {
		url: URL,
		agent: tlsAgent,
		headers: {
			Authorization: `${auth_in.token_type} ${auth_in.access_token}`,
			Accept: "application/json",
			"User-Agent": userAgent,
			"Cache-Control": "no-cache",
		},
	};

	logger("silly", `Retrieving places at ${URL}`);

	try {
		startOnlineOperation();

		let obj = undefined;

		let counter = 0;

		do {
			counter++;
			if (counter > 1) {
				logger("debug", `Polling Life360 places ... try #${counter}`);
			}

			const response = await httpsRequest(options);
			if (response.body && response.body.places) {
				logger("silly", `Retrieved ${response.body.places.length} place(s).`);
				obj = response.body.places;
			} else {
				logger("warn", `Life360 places response body: ${JSON.stringify(response.body)}`);
			}
		} while (counter <= Life360APIDataMaxRetries && obj === undefined);

		if (obj === undefined) {
			logger("warn", "Life360 places data expected but missing! Continuing without places.");
			obj = [];
		}

		stopOnlineOperation();
		return obj;
	} catch (error) {
		logger("error", `Failed to retrieve places: ${error}`);
		stopOnlineOperation();
	}
};
