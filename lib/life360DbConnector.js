/**
 * Creates an ioBroker Object (channel/device)
 *
 * @param {string} dpId The object id
 * @param {string} type The object type ("channel", "device", ...)
 * @param {string} name The object name
 * @param {string} desc The object description
 */
async function createObjectDP(dpId, type, name, desc) {
	try {
		const obj = {
			_id: dpId,
			type: type,
			common: {
				name: name,
				desc: desc,
			},
			native: {},
		};
		await adapter.setObjectNotExistsAsync(dpId, obj);
		return obj;
	} catch (error) {
		adapter.log.error(`Failed to create object id "${dpId}" with definition ${util.inspect(type)}: ${error}`);
		return false;
	}
}
("use strict");

let adapter;

//  Core-modules ...
const GeoUtils = require("geolocation-utils");
const util = require("node:util");

//  ioBroker specific modules
const iobHelpers = require("./iobHelpers");
const myLogger = new iobHelpers.IobLogger(adapter);

const dpPrefix = {
	adapter: null,
	circles: "circles",
	people: "people",
	places: "places",
	myplaces: "myplaces",
};

const dpLife360Type = {
	circle: "channel",
	place: "channel",
	person: "channel",
	members: "channel",
	places: "channel",
	myplace: "channel",
};

let location_unknown_name = "";
let track_location_people = true;
let prioritizeMyPlacesLocationName = false;
let process_life360_circles = true;
let process_life360_places = true;
let process_life360_people = true;
let myPlaces = [];
let dirCircles = [];

/** Pending isPresentDelay timers keyed by dpMember path */
const isPresentDelayTimers = new Map();

/** People dpIds (people.<id>) whose locationName is currently overridden by a MyPlace */
const locationNameActive = new Map();

/** People dpIds (people.<id>) that have a pending arrival delay timer running */
const locationNamePendingDelay = new Set();

/** Telegram notification config */
let notifyTelegramEnabled = false;
let notifyRecipients = [];
let notifyPeople = [];

/** Place-specific notification overrides */
let notifyPlaceOverrides = [];

/** Alexa notification config */
let notifyAlexaEnabled = false;
let notifyAlexaDevices = [];

/** Cached Life360 app places from the last cloud data poll (used for getPlacesList) */
let dirAppPlaces = [];

/** Last known locationName per personDpId – used to detect changes and avoid duplicate notifications */
const lastLocationNames = new Map();

let debugging_verbose = false;

/**
 * Logger is a wrapper for logging.
 *
 * @param {string} level Set to "error", "warn", "info", "debug"
 * @param {string} message The message to log
 */

function logger(level, message) {
	myLogger.logger(level, message);
}

/**
 * Returns a geo-location object for latitude and longitude
 *
 * @param {number} latitude
 * @param {number} longitude
 */

function getGeoLocation(latitude, longitude) {
	return JSON.stringify(GeoUtils.createLocation(latitude, longitude, "LatLng"));
}

/**
 * Returns a sanitized string safe to use as an ioBroker object id.
 * Replaces all forbidden characters, spaces, dots and german Umlaute.
 *
 * @param {string} orgName The original name or id
 * @returns {string} The sanitized name or id
 */
function getSantinizedObjectName(orgName) {
	if (!orgName) {
		return "_";
	}
	return orgName
		.replace(/[äÄ]/g, "ae")
		.replace(/[öÖ]/g, "oe")
		.replace(/[üÜ]/g, "ue")
		.replace(/ß/g, "ss")
		.replace(adapter.FORBIDDEN_CHARS, "_")
		.replace(/\s+/g, "_")
		.replace(/\.+/g, "_")
		.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * Updates the internal circles directory.
 *
 * @param {object[]} circles
 */
async function updateCirclesDirectory(circles) {
	dirCircles = [];

	for (let c in circles) {
		const circle = circles[c];
		dirCircles.push({ id: circle.id, name: circle.name });
	}

	// await setStateReadOnlyValue(`${dpPrefix.circles}.dirCircles`, "dirCircles", "array", "list", JSON.stringify(dirCircles), true);
}

/**
 * Set ioBroker adapter instance for the connector
 *
 *  @param {object} adapter_in The adapter instance for this connector.
 */
exports.setAdapter = function (adapter_in) {
	adapter = adapter_in;
	myLogger.setAdapter(adapter);

	location_unknown_name = adapter.config.location_unknown_name || "";
	track_location_people = adapter.config.track_location_people;
	process_life360_circles = adapter.config.process_life360_circles;
	process_life360_places = adapter.config.process_life360_places;
	process_life360_people = adapter.config.process_life360_people;
	myPlaces = adapter.config.places;
	prioritizeMyPlacesLocationName = adapter.config.prioritizeMyPlacesLocationName || false;
	debugging_verbose = adapter.config.debugging_verbose;
	notifyTelegramEnabled = adapter.config.notify_telegram_enabled || false;
	notifyRecipients = Array.isArray(adapter.config.notify_recipients) ? adapter.config.notify_recipients : [];
	notifyPeople = Array.isArray(adapter.config.notify_people) ? adapter.config.notify_people : [];
	notifyPlaceOverrides = Array.isArray(adapter.config.notify_place_overrides)
		? adapter.config.notify_place_overrides
		: [];
	notifyAlexaEnabled = adapter.config.notify_alexa_enabled || false;
	notifyAlexaDevices = Array.isArray(adapter.config.notify_alexa_devices) ? adapter.config.notify_alexa_devices : [];
};

exports.getPrefix_Circles = function () {
	return dpPrefix.circles;
};

/**
 * Returns a combined list of all known place names (Life360 app places + own places)
 * for use in the admin UI dropdown (getPlacesList command).
 *
 * @returns {{ value: string, label: string }[]} Array of place entries with value and display label
 */
exports.getPlacesList = function () {
	const myPlaceNames = Array.isArray(myPlaces)
		? myPlaces.map(p => ({ value: p.name, label: `\u2691 ${p.name}` }))
		: [];
	const appPlaceNames = dirAppPlaces.map(name => ({ value: name, label: `\uD83D\uDCCD ${name}` }));
	// Merge, deduplicating by value (own places first)
	const seen = new Set(myPlaceNames.map(p => p.value));
	const merged = [...myPlaceNames];
	for (const p of appPlaceNames) {
		if (!seen.has(p.value)) {
			merged.push(p);
			seen.add(p.value);
		}
	}
	return merged;
};

/**
 * Returns the list of all known Life360 persons (from the notify_people config)
 * for use in the admin UI dropdown (getPersonsList command).
 *
 * @returns {{ value: string, label: string }[]} Array of person entries with value and display label
 */
exports.getPersonsList = function () {
	return notifyPeople.filter(p => p.personName).map(p => ({ value: p.personName, label: p.personName }));
};

exports.clearTimers = function () {
	for (const timer of isPresentDelayTimers.values()) {
		clearTimeout(timer);
	}
	isPresentDelayTimers.clear();
	locationNameActive.clear();
	locationNamePendingDelay.clear();
	lastLocationNames.clear();
};

/**
 * Pre-populates lastLocationNames from the current ioBroker DB states before the first poll.
 * This allows the notification system to detect genuine location transitions that occurred
 * while the adapter was offline, instead of suppressing the first notification for every person.
 *
 * Must be called once after setAdapter() and before polling starts.
 *
 * @returns {Promise<void>}
 */
exports.initNotificationBaselines = async function () {
	if (!notifyTelegramEnabled && !notifyAlexaEnabled) {
		return; // Notifications disabled – no need to read DB
	}
	const ns = adapter.namespace;
	try {
		const objects = await adapter.getObjectViewAsync("system", "channel", {
			startkey: `${ns}.${dpPrefix.people}.`,
			endkey: `${ns}.${dpPrefix.people}.\u9999`,
		});
		for (const row of objects.rows) {
			const channelId = row.value._id; // e.g. "life360ng.0.people.<uuid>"
			if (channelId.split(".").length !== 4) {
				continue; // skip nested channels
			}
			const relativeKey = channelId.slice(ns.length + 1); // "people.<uuid>"
			try {
				const state = await adapter.getStateAsync(`${relativeKey}.locationName`);
				if (state && state.val !== null && state.val !== undefined) {
					const displayVal = String(state.val);
					const isUnknown = !displayVal || displayVal === location_unknown_name;
					lastLocationNames.set(relativeKey, isUnknown ? "__unknown__" : displayVal);
				}
			} catch {
				// State not found or DB error for this person – skip
			}
		}
	} catch {
		// DB error – leave lastLocationNames empty, fall back to first-run suppression
	}
};

/**
 * Synchronizes the notify_people config with the current Life360 persons.
 * Adds newly discovered persons and removes persons no longer in Life360.
 * Updates the adapter config via updateConfig() when changes are detected.
 *
 * @returns {Promise<void>}
 */
exports.syncNotifyPeople = async function () {
	const ns = adapter.namespace;
	let objects;
	try {
		objects = await adapter.getObjectViewAsync("system", "channel", {
			startkey: `${ns}.people.`,
			endkey: `${ns}.people.\u9999`,
		});
	} catch (e) {
		adapter.log.debug(`[Notify] Could not sync persons from DB: ${e.message}`);
		return;
	}

	const knownNames = objects.rows.map(r => r.value?.common?.name).filter(Boolean);
	if (knownNames.length === 0) {
		return;
	}

	let people = Array.isArray(adapter.config.notify_people) ? [...adapter.config.notify_people] : [];
	let changed = false;

	for (const name of knownNames) {
		if (!people.find(p => p.personName === name)) {
			people.push({
				personName: name,
				prefixText: "",
				unknownPlacesMessage: "",
				recipients: "",
				notifyMyPlaces: true,
				notifyAppPlaces: true,
				notifyUnknownPlaces: false,
			});
			changed = true;
			adapter.log.info(`[Notify] New person added to notification config: ${name}`);
		}
	}

	const removed = people.filter(p => !knownNames.includes(p.personName));
	if (removed.length > 0) {
		for (const p of removed) {
			adapter.log.info(`[Notify] Person removed from notification config: ${p.personName}`);
		}
		people = people.filter(p => knownNames.includes(p.personName));
		changed = true;
	}

	if (changed) {
		notifyPeople = people;
		await adapter.updateConfig({ notify_people: people });
	}
};

/**
 * Sends a test Telegram notification using the running adapter configuration.
 * The adapter must have been started with notifications enabled for the test to work.
 *
 * @returns {Promise<{result?: string, error?: string}>} Result or error message
 */
exports.sendTestTelegram = async function () {
	if (!notifyTelegramEnabled) {
		return {
			error: "Telegram notifications are disabled. Please save the configuration and restart the adapter first.",
		};
	}
	if (notifyRecipients.length === 0) {
		return { error: "No recipients configured. Please save the configuration and restart the adapter first." };
	}

	const testMessage = "[Life360ng] Test notification";
	let sent = 0;
	const errors = [];

	for (const recipient of notifyRecipients) {
		if (!recipient.chatId) {
			continue;
		}
		const instance =
			recipient.instance !== undefined && recipient.instance !== null && recipient.instance !== ""
				? Number(recipient.instance)
				: 0;
		try {
			adapter.sendTo(`telegram.${instance}`, "send", {
				text: testMessage,
				chatId: String(recipient.chatId),
			});
			adapter.log.info(
				`[Notify] Test: Sent Telegram to ${recipient.name || recipient.chatId} (instance ${instance})`,
			);
			sent++;
		} catch (error) {
			errors.push(`${recipient.name || recipient.chatId}: ${error.message}`);
		}
	}

	if (errors.length > 0 && sent === 0) {
		return { error: errors.join(", ") };
	}
	if (errors.length > 0) {
		return { result: `Sent to ${sent} recipient(s), errors: ${errors.join(", ")}` };
	}
	return { result: `Test sent to ${sent} recipient(s)` };
};

/**
 * Sends a test Alexa announcement using the running adapter configuration.
 * The adapter must have been started with notifications enabled for the test to work.
 *
 * @returns {Promise<{result?: string, error?: string}>} Result or error message
 */
exports.sendTestAlexa = async function () {
	if (!notifyAlexaEnabled) {
		return {
			error: "Alexa notifications are disabled. Please save the configuration and restart the adapter first.",
		};
	}
	if (notifyAlexaDevices.length === 0) {
		return { error: "No Alexa devices configured. Please save the configuration and restart the adapter first." };
	}

	const testMessage = "Life360ng test notification";
	let sent = 0;
	const errors = [];

	for (const device of notifyAlexaDevices) {
		if (!device.speakStateId) {
			continue;
		}
		const vol =
			device.volume !== undefined && device.volume !== null && device.volume !== "" ? Number(device.volume) : 50;
		const speakText = vol > 0 ? `${vol};${testMessage}` : testMessage;
		try {
			await adapter.setForeignStateAsync(device.speakStateId, speakText);
			adapter.log.info(`[Notify] Test: Sent Alexa speak to ${device.label || device.speakStateId}`);
			sent++;
		} catch (error) {
			errors.push(`${device.label || device.speakStateId}: ${error.message}`);
		}
	}

	if (errors.length > 0 && sent === 0) {
		return { error: errors.join(", ") };
	}
	if (errors.length > 0) {
		return { result: `Sent to ${sent} device(s), errors: ${errors.join(", ")}` };
	}
	return { result: `Test sent to ${sent} device(s)` };
};

/**
 * Creates an OpenStreetMap URL to show the given position.
 *
 * @param {number} lat Set to GPS latitude.
 * @param {number} lon Set to GPS longitude.
 * @param {number} zoom Set to zoom factor 1 up to 19.
 */

function getOpenStreetMapUrl(lat, lon, zoom) {
	if (!zoom) {
		zoom = 15;
	}
	return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=${zoom}/${lat}/${lon}`;
}

/**
 * Returns an OpenStreetMap embed URL (iFrame-compatible) for a given geo-position.
 *
 * @param {number} lat Latitude
 * @param {number} lon Longitude
 * @param {number} zoom Zoom level 1-20, defaults to 15.
 */
function getOsmEmbedUrl(lat, lon, zoom) {
	if (!zoom) {
		zoom = 15;
	}
	// Calculate a small bounding box around the marker
	const delta = 0.005; // ~500m
	const lat1 = (lat - delta).toFixed(6);
	const lat2 = (lat + delta).toFixed(6);
	const lon1 = (lon - delta).toFixed(6);
	const lon2 = (lon + delta).toFixed(6);
	return `https://www.openstreetmap.org/export/embed.html?bbox=${lon1},${lat1},${lon2},${lat2}&layer=mapnik&marker=${lat},${lon}`;
}

/**
 * Returns a Google Maps embed URL (iFrame-compatible) for a given geo-position.
 *
 * @param {number} lat Latitude
 * @param {number} lon Longitude
 * @param {number} zoom Zoom level 1-20, defaults to 15.
 */
function getMapsIframeUrl(lat, lon, zoom) {
	if (!zoom) {
		zoom = 15;
	}
	return `https://maps.google.com/maps?q=${lat},${lon}&z=${zoom}&output=embed`;
}

/**
 * ============================================================================
 * ----------------------------------------------------------------------------
 *      ioBroker Datapoint helper functions
 * ----------------------------------------------------------------------------
 * ============================================================================
 */

/**
 * Creates an ioBroker Datapoint Object
 *
 * @param {string} dpId The datapoint's id.
 * @param {object} obj ioBroker datapoint object.
 */
async function createDataPointRawAsync(dpId, obj) {
	try {
		//  Create ioBroker object if it does not exists
		await adapter.setObjectNotExistsAsync(dpId, obj);
		return obj;
	} catch (error) {
		adapter.log.error(`Failed to create datapoint id "${dpId}" with definition ${util.inspect(obj)}: ${error}`);
		return false;
	}
}

/**
 * Wrapper to easily create an ioBroker State datapoint
 *
 * @param {string} dpId The datapoint's id
 * @param {string} dpName Name of the datapoint
 * @param {boolean} dpRead Set to true to grant read access to the datapoint.
 * @param {boolean} dpWrite Set to true to grad write access to the datapoint.
 * @param {string} dpType Type of the datapoint
 * @param {string} dpRole Role of the datapoint
 */
async function createStateDP(dpId, dpName, dpRead, dpWrite, dpType, dpRole) {
	const obj = {
		_id: dpId,
		type: "state",
		common: {
			name: dpName,
			read: dpRead,
			write: dpWrite,
			type: dpType,
			role: dpRole,
		},
		native: {},
	};

	//  Create ioBroker object if it does not exists
	return await createDataPointRawAsync(dpId, obj);
}

/**
 * Creates a state datapoint and to set it's value.
 *
 * @param {string} dpId The datapoint's id
 * @param {string} dpName Name of the datapoint
 * @param {boolean} dpRead Set to true to grant read access to the datapoint.
 * @param {boolean} dpWrite Set to true to grad write access to the datapoint.
 * @param {string} dpType Type of the datapoint
 * @param {string} dpRole Role of the datapoint
 * @param {unknown} val The state's value
 * @param {boolean} ack Ack?
 */
async function setStateValue(dpId, dpName, dpRead, dpWrite, dpType, dpRole, val, ack) {
	myLogger.silly(`setStateValue --> ${dpId} = ${val}`);

	try {
		//  Create ioBroker state object
		createStateDP(dpId, dpName, dpRead || true, dpWrite, dpType, dpRole).then(async o => {
			await adapter.setStateAsync(dpId, val, ack);
			return o;
		});
	} catch (error) {
		adapter.log.error(`Failed to set value "${val}" for datapoint id "${dpId}": ${error}`);
		return false;
	}
}

/**
 * Wrapper to create a read only state datapoint and to set it's value.
 *
 * @param {string} dpId The datapoint's id
 * @param {string} dpName Name of the datapoint
 * @param {string} dpType Type of the datapoint
 * @param {string} dpRole Role of the datapoint
 * @param {unknown} val The state's value
 * @param {boolean} ack Ack?
 */
async function setStateReadOnlyValue(dpId, dpName, dpType, dpRole, val, ack) {
	// myLogger.silly(`setStateReadOnlyValue --> ${dpId} = ${val}`);
	return setStateValue(dpId, dpName, true, false, dpType, dpRole, val, ack);
}

/**
 * Returns an array of persons for the members of the given circles.
 *
 * @param {Array} circles The Life360 circles to process.
 */
function getPersons(circles) {
	let persons = [];

	for (let c in circles) {
		const circle = circles[c];

		for (let m in circle.members) {
			const member = circle.members[m];
			const index = persons.findIndex(person => person.id === member.id);

			if (index == -1) {
				//  Add new person to the array
				member.memberOf = [{ id: circle.id, name: circle.name }];
				persons.push(member);
			} else {
				//  Update member's membership information.
				persons[index].memberOf.push({ id: circle.id, name: circle.name });
			}
		}
	}

	return persons;
}

/**
 * Returns an array of places for the given circles.
 *
 * @param {Array} circles The Life360 circles to process.
 */
function getPlaces(circles) {
	let places = [];

	for (let c in circles) {
		const circle = circles[c];

		for (let p in circle.places) {
			const place = circle.places[p];

			if (!places.some(aPlace => aPlace.id === place.id)) {
				//  Add new place to the array
				places.push(place);
			}
		}
	}

	return places;
}

/**
 * ============================================================================
 * ----------------------------------------------------------------------------
 *      This is the primary receiver for the Life360 cloud data (circles.)
 * ----------------------------------------------------------------------------
 * ============================================================================
 */

/**
 * This is the primary receiver for the Life360 cloud data (circles.)
 *
 * @param {boolean|Error} err Set to false, if no error occured, otherwise Error object.
 * @param {object} cloud_data The cloud data object to publish to ioBroker.
 */
exports.publishCloudData = async function (err, cloud_data) {
	if (!err) {
		//  Check if cloud_data contains data.
		if (cloud_data && cloud_data.circles) {
			//  Simple check for valid data
			//  Life360 should provide at least one circle and one member!
			if (cloud_data.circles.length > 0) {
				//  Update circles directory.
				updateCirclesDirectory(cloud_data.circles);

				//  Get all Life360 places from the circles.
				cloud_data.places = getPlaces(cloud_data.circles);

				//  Cache app places for getPlacesList
				dirAppPlaces = cloud_data.places.map(p => p.name).filter(Boolean);

				//  Get all Life360 circles' members.
				cloud_data.persons = getPersons(cloud_data.circles);

				if (cloud_data.persons.length > 0) {
					//  Publish MyPlaces
					await publishMyPlaces(myPlaces, cloud_data.persons);

					//  Publish all known Life360 places to ioBroker
					if (process_life360_places) {
						await publishPlaces(cloud_data.places);
					}

					//  Publish all known Life360 circles' members
					if (process_life360_people) {
						await publishPeople(cloud_data.persons);
					}

					//  Publish the circles
					if (process_life360_circles) {
						await publishCircles(cloud_data.circles);
					}

					//  That's it.
					myLogger.debug("Life360 cloud data processed.");
				} else {
					myLogger.warn("No people data received from Life360. Aborting");
					adapter.setState("info.connection", false, true);
				}
			} else {
				myLogger.warn("No circle data received from Life360. Aborting.");
				adapter.setState("info.connection", false, true);
			}
		} else {
			//  No data received from Life360
			myLogger.warn("No data received from Life360 cloud services!");
			adapter.setState("info.connection", false, true);
		}
	} else {
		logger("error", err);
	}
};

/**
 * ============================================================================
 * ----------------------------------------------------------------------------
 *      Functions to publish Life360 places to ioBroker
 * ----------------------------------------------------------------------------
 * ============================================================================
 */

/**
 *
 * @param {object[]} places
 */
async function publishPlaces(places) {
	for (let p in places) {
		try {
			publishPlace(places[p]);
			myLogger.silly(`Created / updated place ${places[p].id} --> ${places[p].name}`);
		} catch (error) {
			myLogger.error(error);
		}
	}

	//  Cleanup stale places
	const currentPlaces = await adapter.getChannelsOfAsync("");

	for (let cp in currentPlaces) {
		if (
			currentPlaces[cp]._id.startsWith(`${adapter.namespace}.${dpPrefix.places}.`) &&
			currentPlaces[cp]._id.split(".").length == 4
		) {
			if (!places.some(myPlace => currentPlaces[cp]._id.endsWith(myPlace.id))) {
				//  Place no longer exists in Life360 – remove immediately.
				deleteMyObject(currentPlaces[cp]._id);
				adapter.log.info(`Removed ${currentPlaces[cp].common.name} from Life360 places.`);
			}
		}
	}

	myLogger.debug(`Published ${places.length} place(s) to ioBroker.`);
}

/**
 *
 * @param {object} place
 */
async function publishPlace(place) {
	// {
	//     "id": "<GUID>",
	//     "ownerId": "owner <GUID>",
	//     "circleId": "circle <GUID>",
	//     "name": "<Name of the place>",
	//     "latitude": "<LAT>",
	//     "longitude": "<LON>",
	//     "radius": "<RADIUS>",
	//     "type": null,
	//     "typeLabel": null
	// },

	//  Create an object for the place
	const dpPlace = `${dpPrefix.places}.${place.id}`;
	await createObjectDP(dpPlace, dpLife360Type.place, place.name, place.name);

	//  Now set the place's states.
	const lat = Number(place.latitude) || 0;
	const lng = Number(place.longitude) || 0;

	await setStateReadOnlyValue(`${dpPlace}.id`, "id", "string", "text", place.id, true);
	await setStateReadOnlyValue(`${dpPlace}.ownerId`, "ownerId", "string", "text", place.ownerId, true);
	await setStateReadOnlyValue(`${dpPlace}.circleId`, "circleId", "string", "text", place.circleId, true);
	await setStateReadOnlyValue(`${dpPlace}.name`, "name", "string", "text", place.name, true);
	await setStateReadOnlyValue(`${dpPlace}.latitude`, "latitude", "number", "value.gps.latitude", lat, true);
	await setStateReadOnlyValue(`${dpPlace}.longitude`, "longitude", "number", "value.gps.longitude", lng, true);
	await setStateReadOnlyValue(
		`${dpPlace}.gps-coordinates`,
		"gps-coordinates",
		"string",
		"value.gps",
		getGeoLocation(lat, lng),
		true,
	);
	await setStateReadOnlyValue(`${dpPlace}.radius`, "radius", "number", "value", Number(place.radius) || 0, true);

	await setStateReadOnlyValue(`${dpPlace}.timestamp`, "timestamp", "number", "date", Date.now(), true);

	//  Finally create an OpenStreetMap URL
	await setStateReadOnlyValue(
		`${dpPlace}.urlMap`,
		"urlMap",
		"string",
		"text.url",
		getOpenStreetMapUrl(lat, lng, 15),
		true,
	);
	await setStateReadOnlyValue(
		`${dpPlace}.urlMapIframe`,
		"urlMapIframe",
		"string",
		"text.url",
		getMapsIframeUrl(lat, lng, 15),
		true,
	);
}

/**
 * ============================================================================
 * ----------------------------------------------------------------------------
 *      Functions to publish Life360 people to ioBroker
 * ----------------------------------------------------------------------------
 * ============================================================================
 */

/**
 * Finds a matching place override entry for a given person, place and event type.
 * Exact person match takes precedence over a wildcard entry (empty personName).
 *
 * @param {string} personFullName Life360 full name of the person
 * @param {string} placeName Name of the place
 * @param {'arrival'|'leave'} eventType
 * @returns {{ suppress: boolean, shouldNotify: boolean, text: string } | null} Override config or null if no match found
 */
function getPlaceOverride(personFullName, placeName, eventType) {
	const override =
		notifyPlaceOverrides.find(o => o.placeName === placeName && o.personName === personFullName) ||
		notifyPlaceOverrides.find(o => o.placeName === placeName && !o.personName);

	if (!override) {
		return null;
	}

	return {
		suppress: !!override.prioritize,
		shouldNotify: eventType === "arrival" ? !!override.notifyArrival : !!override.notifyLeave,
		text: ((eventType === "arrival" ? override.arrivalText : override.leaveText) || "").trim(),
	};
}

/**
 * Dispatches a notification message via Telegram and/or Alexa for a given person config.
 *
 * @param {string} message The message to send
 * @param {object} personConfig The person's notification config (from notify_people)
 */
async function _dispatchNotification(message, personConfig) {
	if (notifyTelegramEnabled) {
		const allowedTokens = (personConfig.recipients || "")
			.split(",")
			.map(s => s.trim().toLowerCase())
			.filter(Boolean);

		for (const recipient of notifyRecipients) {
			if (!recipient.chatId) {
				continue;
			}
			if (allowedTokens.length > 0) {
				const recipientName = (recipient.name || "").trim().toLowerCase();
				const recipientChatId = String(recipient.chatId).trim().toLowerCase();
				if (!allowedTokens.includes(recipientName) && !allowedTokens.includes(recipientChatId)) {
					continue;
				}
			}
			const instance =
				recipient.instance !== undefined && recipient.instance !== null && recipient.instance !== ""
					? Number(recipient.instance)
					: 0;
			try {
				adapter.sendTo(`telegram.${instance}`, "send", {
					text: message,
					chatId: String(recipient.chatId),
				});
				adapter.log.debug(
					`Notification: Sent Telegram to ${recipient.name || recipient.chatId} (instance ${instance}): "${message}"`,
				);
			} catch (error) {
				adapter.log.warn(`Notification: Failed to send Telegram to ${recipient.chatId}: ${error.message}`);
			}
		}
	}

	if (notifyAlexaEnabled && notifyAlexaDevices.length > 0) {
		for (const device of notifyAlexaDevices) {
			if (!device.speakStateId) {
				continue;
			}
			const vol =
				device.volume !== undefined && device.volume !== null && device.volume !== ""
					? Number(device.volume)
					: 50;
			const speakText = vol > 0 ? `${vol};${message}` : message;
			try {
				await adapter.setForeignStateAsync(device.speakStateId, speakText);
				adapter.log.debug(
					`Notification: Sent Alexa speak to ${device.label || device.speakStateId}: "${speakText}"`,
				);
			} catch (error) {
				adapter.log.warn(
					`Notification: Failed to send Alexa speak to ${device.speakStateId}: ${error.message}`,
				);
			}
		}
	}
}

/**
 * Sends notifications when a person's location changes.
 * Handles both standard notifications and place-specific overrides.
 * Only fires when the locationName actually changed.
 *
 * @param {string} personDpId The person's ioBroker datapoint id (e.g. "people.abc123")
 * @param {string} personFullName The person's full name as stored in Life360 (e.g. "Max Mustermann")
 * @param {string} newLocationName The new location name to notify about
 * @param {'myplace'|'appplace'|'unknown'} locationType Whether this is a custom place, a Life360 app place, or an unknown location
 */
async function sendLocationNotification(personDpId, personFullName, newLocationName, locationType) {
	if (!notifyTelegramEnabled && !notifyAlexaEnabled) {
		return;
	}
	if (!newLocationName) {
		return;
	}

	// Only notify when locationName actually changed (suppress duplicates on every poll)
	const lastKnown = lastLocationNames.get(personDpId);
	if (lastKnown === undefined) {
		// First run for this person since adapter start.
		// lastLocationNames is pre-populated by initNotificationBaselines() before the first poll,
		// so undefined here means a person that didn't exist in the DB yet → suppress.
		lastLocationNames.set(personDpId, newLocationName);
		return;
	}
	if (lastKnown === newLocationName) {
		return;
	}
	lastLocationNames.set(personDpId, newLocationName);

	const personConfig = notifyPeople.find(p => p.personName === personFullName);
	if (!personConfig) {
		return;
	}

	// --- Leave notification for the previous place (override-driven only) ---
	if (lastKnown && lastKnown !== "__unknown__") {
		const leaveOverride = getPlaceOverride(personFullName, lastKnown, "leave");
		if (leaveOverride && leaveOverride.shouldNotify && leaveOverride.text) {
			await _dispatchNotification(leaveOverride.text, personConfig);
		}
	}

	// --- Arrival notification for the new place ---
	if (locationType === "myplace" && !personConfig.notifyMyPlaces) {
		return;
	}
	if (locationType === "appplace" && !personConfig.notifyAppPlaces) {
		return;
	}
	if (locationType === "unknown" && !personConfig.notifyUnknownPlaces) {
		return;
	}

	// Check for an arrival override (not applicable for unknown location)
	const arrivalOverride =
		newLocationName !== "__unknown__" ? getPlaceOverride(personFullName, newLocationName, "arrival") : null;

	let message = null;
	let shouldSend = true;

	if (arrivalOverride) {
		if (arrivalOverride.shouldNotify && arrivalOverride.text) {
			message = arrivalOverride.text;
		} else if (!arrivalOverride.shouldNotify) {
			shouldSend = false;
		}
		// suppress=true but no override text → fall through to standard message
		if (arrivalOverride.suppress && !message) {
			shouldSend = true;
		}
	}

	if (shouldSend && !message) {
		// Build standard message
		if (locationType === "unknown") {
			message = (personConfig.unknownPlacesMessage || "").trim();
			if (!message) {
				return;
			}
		} else {
			const rawPrefix = (personConfig.prefixText || "").trim();
			message = rawPrefix ? `${rawPrefix} ${newLocationName}` : newLocationName;
		}
	}

	if (!shouldSend || !message) {
		return;
	}

	await _dispatchNotification(message, personConfig);
}

/**
 *
 * @param {object[]} persons
 */
async function publishPeople(persons) {
	for (let p in persons) {
		try {
			publishPerson(persons[p]);
			myLogger.silly(`Created / updated person ${persons[p].id} --> ${persons[p].name}`);
		} catch (error) {
			myLogger.error(error);
		}
	}

	//  Cleanup stale people
	const currentPeople = await adapter.getChannelsOfAsync("");

	for (let cp in currentPeople) {
		if (
			currentPeople[cp]._id.startsWith(`${adapter.namespace}.${dpPrefix.people}.`) &&
			currentPeople[cp]._id.split(".").length == 4
		) {
			if (!persons.some(myPerson => currentPeople[cp]._id.endsWith(myPerson.id))) {
				//  Person no longer exists in Life360 – remove immediately.
				deleteMyObject(currentPeople[cp]._id);
				adapter.log.info(`Removed ${currentPeople[cp].common.name} from Life360 people.`);
			}
		}
	}

	myLogger.debug(`Published ${persons.length} people to ioBroker.`);
}

/**
 *
 * @param {object} person
 * @param {string} idParentDp
 */
async function publishPerson(person, idParentDp) {
	/*
	{
		"features": {
			"device": "1",
			"smartphone": "1",
			"nonSmartphoneLocating": "0",
			"geofencing": "1",
			"shareLocation": "1",
			"shareOffTimestamp": null,
			"disconnected": "0",
			"pendingInvite": "0",
			"mapDisplay": "1"
		},
		"issues": {
			"disconnected": "0",
			"type": null,
			"status": null,
			"title": null,
			"dialog": null,
			"action": null,
			"troubleshooting": "0"
		},
		"location": {
			"latitude": "<LAT>",
			"longitude": "<LON>",
			"accuracy": "<ACCURACY>",
			"startTimestamp": <UNIX Timestamp>,
			"endTimestamp": "<UNIX Timestamp>",
			"since": <UNIX Timestamp>,
			"timestamp": "<UNIX Timestamp>",
			"name": null,
			"placeType": null,
			"source": null,
			"sourceId": null,
			"address1": null,
			"address2": "",
			"shortAddress": "",
			"inTransit": "0",
			"tripId": null,
			"driveSDKStatus": null,
			"battery": "<BATT LEVEL>",
			"charge": "0",
			"wifiState": "1",
			"speed": 0,
			"isDriving": "0",
			"userActivity": null
		},
		"communications": [
			{
				"channel": "Voice",
				"value": "+1....",
				"type": "Home"
			},
			{
				"channel": "Email",
				"value": "me@my.local",
				"type": null
			}
		],
		"medical": null,
		"relation": null,
		"createdAt": "<UNIX Timestamp>",
		"activity": null,
		"id": "<GUID>",
		"firstName": "...",
		"lastName": "...",
		"isAdmin": "0",
		"avatar": null,
		"pinNumber": null,
		"loginEmail": "me@my.local",
		"loginPhone": "+1...."
	}
	*/

	//  Create an object for the person
	let dpId = `${dpPrefix.people}.${person.id}`;
	if (typeof idParentDp !== "undefined") {
		dpId = `${idParentDp}.${person.id}`;
	}

	await createObjectDP(
		dpId,
		dpLife360Type.person,
		`${person.firstName} ${person.lastName}`,
		`${person.firstName} ${person.lastName}`,
	);

	//  Now set the person's states.
	await setStateReadOnlyValue(`${dpId}.id`, "id", "string", "text", person.id, true);
	await setStateReadOnlyValue(
		`${dpId}.createdAt`,
		"createdAt",
		"number",
		"date",
		Number(person.createdAt || 0) * 1000,
		true,
	);
	await setStateReadOnlyValue(`${dpId}.firstName`, "firstName", "string", "text", person.firstName, true);
	await setStateReadOnlyValue(`${dpId}.lastName`, "lastName", "string", "text", person.lastName, true);
	await setStateReadOnlyValue(`${dpId}.avatar`, "avatar", "string", "text.url", person.avatar, true);
	const personIssues = person.issues || {};
	await setStateReadOnlyValue(
		`${dpId}.disconnected`,
		"disconnected",
		"boolean",
		"indicator",
		Boolean(personIssues.disconnected),
		true,
	);
	await setStateReadOnlyValue(
		`${dpId}.isConnected`,
		"isConnected",
		"boolean",
		"indicator.reachable",
		!personIssues.disconnected,
		true,
	);
	await setStateReadOnlyValue(`${dpId}.status`, "status", "string", "text", personIssues.status || "Ok", true);
	// await setStateReadOnlyValue(`${dpId}.wifiState`, "wifiState", "number", "value", (Number(person.location.wifiState) || 0), true);
	// await setStateReadOnlyValue(`${dpId}.charge`, "charge", "boolean", "indicator", Boolean(person.location.charge), true);

	await setStateReadOnlyValue(`${dpId}.timestamp`, "timestamp", "number", "date", Date.now(), true);

	//  Track member's location data?
	await setStateReadOnlyValue(
		`${dpId}.isSharingLocation`,
		"isSharingLocation",
		"boolean",
		"indicator",
		(person.location && true) || false,
		true,
	);

	if (person.location) {
		const lat = Number(person.location.latitude) || 0;
		const lng = Number(person.location.longitude) || 0;

		if (track_location_people) {
			//  Geo position
			await setStateReadOnlyValue(`${dpId}.latitude`, "latitude", "number", "value.gps.latitude", lat, true);
			await setStateReadOnlyValue(`${dpId}.longitude`, "longitude", "number", "value.gps.longitude", lng, true);
			await setStateReadOnlyValue(
				`${dpId}.gps-coordinates`,
				"gps-coordinates",
				"string",
				"value.gps",
				getGeoLocation(lat, lng),
				true,
			);
			await setStateReadOnlyValue(
				`${dpId}.lastPositionAt`,
				"lastPositionAt",
				"number",
				"date",
				Number(person.location.timestamp || 0) * 1000,
				true,
			);
			await setStateReadOnlyValue(
				`${dpId}.battery`,
				"battery",
				"number",
				"value.battery",
				Number(person.location.battery || 0),
				true,
			);
			//  Create an OpenStreetMap URL
			await setStateReadOnlyValue(
				`${dpId}.urlMap`,
				"urlMap",
				"string",
				"text.url",
				getOpenStreetMapUrl(lat, lng, 15),
				true,
			);
			await setStateReadOnlyValue(
				`${dpId}.urlMapIframe`,
				"urlMapIframe",
				"string",
				"text.url",
				getMapsIframeUrl(lat, lng, 15),
				true,
			);
			// OpenStreetMap Embed (iFrame)
			await setStateReadOnlyValue(
				`${dpId}.urlMapOsmIframe`,
				"urlMapOsmIframe",
				"string",
				"text.url",
				getOsmEmbedUrl(lat, lng, 15),
				true,
			);
		}

		//  Current place name from Life360 (skip if a MyPlace locationName override is active or delay timer is pending)
		if (!locationNameActive.has(dpId) && !locationNamePendingDelay.has(dpId)) {
			await setStateReadOnlyValue(
				`${dpId}.locationName`,
				"locationName",
				"string",
				"text",
				person.location.name || location_unknown_name,
				true,
			);
			// Notify when person arrives at a Life360 app place, or when location becomes unknown
			if (person.location.name) {
				await sendLocationNotification(
					dpId,
					`${person.firstName} ${person.lastName}`,
					person.location.name,
					"appplace",
				);
			} else {
				await sendLocationNotification(
					dpId,
					`${person.firstName} ${person.lastName}`,
					"__unknown__",
					"unknown",
				);
			}
		}
	}
}

/**
 * ============================================================================
 * ----------------------------------------------------------------------------
 *      Functions to publish Life360 circles to ioBroker
 * ----------------------------------------------------------------------------
 * ============================================================================
 */

/**
 *
 * @param {object[]} circles
 */
async function publishCircles(circles) {
	for (let c in circles) {
		try {
			publishCircle(circles[c]);
		} catch (error) {
			myLogger.error(error);
		}
	}

	//  Cleanup stale circles
	const currentCircles = await adapter.getChannelsOfAsync("");

	for (let cc in currentCircles) {
		if (
			currentCircles[cc]._id.startsWith(`${adapter.namespace}.${dpPrefix.circles}.`) &&
			currentCircles[cc]._id.split(".").length == 4
		) {
			if (!circles.some(myCircle => currentCircles[cc]._id.endsWith(myCircle.id))) {
				//  Circle no longer exists in Life360 – remove immediately.
				deleteMyObject(currentCircles[cc]._id);
				adapter.log.debug(`Removed ${currentCircles[cc].common.name} from Life360 circles.`);
			}
		}
	}

	myLogger.debug(`Published ${circles.length} circle(s) to ioBroker.`);
}

/**
 *
 * @param {object} circle
 * @param {string} idParentDp
 */
async function publishCircle(circle, idParentDp) {
	//  Create an object for the circle
	let dpId;
	if (typeof idParentDp === "undefined") {
		dpId = `${dpPrefix.circles}.${circle.id}`;
	} else {
		dpId = `${idParentDp}.${circle.id}`;
	}

	await createObjectDP(dpId, dpLife360Type.circle, `${circle.name}`, `Life360 circle for ${circle.name}`);

	//  Now set the circle's states.
	await setStateReadOnlyValue(`${dpId}.id`, "id", "string", "text", circle.id, true);
	await setStateReadOnlyValue(`${dpId}.name`, "name", "string", "text", circle.name, true);
	await setStateReadOnlyValue(
		`${dpId}.memberCount`,
		"memberCount",
		"number",
		"value",
		Number(circle.memberCount),
		true,
	);
	await setStateReadOnlyValue(
		`${dpId}.createdAt`,
		"createdAt",
		"number",
		"date",
		Number(circle.createdAt) * 1000,
		true,
	);

	await setStateReadOnlyValue(`${dpId}.timestamp`, "timestamp", "number", "date", Date.now(), true);

	//  Publish the circle's places including members' status.
	publishCirclePlaces(dpId, circle);
}

/**
 *
 * @param {string} idDP
 * @param {object} circle
 */
async function publishCirclePlaces(idDP, circle) {
	const members = getPersons([circle]);
	const places = getPlaces([circle]);

	//  Are there any places?
	if (places.length > 0) {
		//  Create an object datapoint for the circle's places.
		const idCirclePlaces = `${idDP}.places`;
		if (createObjectDP(idCirclePlaces, dpLife360Type.places, "Places", `${circle.name}'s places`)) {
			//  Places DP has been created.
			for (let p in places) {
				const place = places[p];
				//  Create an object datapoint for the place.
				const idPlace = `${idCirclePlaces}.${place.id}`;

				if (createObjectDP(idPlace, dpLife360Type.place, place.name, `${place.name} (${circle.name})`)) {
					//  Place DP created.
					let memberCount = 0;

					for (let m in members) {
						const member = members[m];
						try {
							//  Has member entered the place?
							let memberEntered = false;

							//  Issue #18: Error TypeError: Cannot read property 'sourceId' of null since update to 0.2.8
							//  Check if member provides location information and sourceId for location.
							if (member.location && member.location.sourceId) {
								const memberIssues = member.issues || {};
								if (Number(memberIssues.disconnected) == 0) {
									memberEntered = member.location.sourceId === place.id;
								}
							} else {
								// Member does not provide any location information. (Issue #18)
								if (debugging_verbose) {
									adapter.log.debug(
										`${member.firstName} ${member.lastName} @ ${place.name} (${circle.name}) does not provide any location information.`,
									);
									adapter.log.silly(util.inspect(member));
								}
							}

							if (memberEntered) {
								memberCount += 1;
							}

							//  Create an object datapoint for the member.
							const idMember = `${idPlace}.${member.id}`;
							if (
								createObjectDP(
									idMember,
									dpLife360Type.person,
									`${member.firstName} @ ${place.name}`,
									`${member.firstName} ${member.lastName} @ ${place.name} (${circle.name})`,
								)
							) {
								//  Member DP created.

								//  Indicate if member is present at the place.
								await setStateReadOnlyValue(
									`${idMember}.isPresent`,
									"Present",
									"boolean",
									"indicator",
									memberEntered,
									true,
								);
							}
						} catch (error) {
							adapter.log.error(
								`Failed to process member information ${member.firstName} ${member.lastName} @ ${place.name} (${circle.name}): ${error}`,
							);
						}
					}

					//  Cleanup stale people
					const currentPeople = await adapter.getChannelsOfAsync("");

					for (let cp in currentPeople) {
						if (
							currentPeople[cp]._id.startsWith(
								`${adapter.namespace}.${dpPrefix.circles}.${circle.id}.places.${place.id}.`,
							) &&
							currentPeople[cp]._id.split(".").length == 7
						) {
							if (!members.some(myPerson => currentPeople[cp]._id.endsWith(myPerson.id))) {
								//  Person no longer exists in this circle – remove immediately.
								deleteMyObject(currentPeople[cp]._id);
								adapter.log.debug(
									`Removed ${currentPeople[cp].common.name} from Life360 circle ${circle.name}.`,
								);
							}
						}
					}

					//  Indicate the count of members present at the place.
					await setStateReadOnlyValue(
						`${idPlace}.membersPresent`,
						`People @ ${place.name}`,
						"number",
						"value",
						memberCount,
						true,
					);
				}
			}
		}
	}

	//  Cleanup stale places of circle
	const currentPlaces = await adapter.getDevicesAsync();

	for (let i in currentPlaces) {
		if (
			currentPlaces[i]._id.startsWith(`${adapter.namespace}.${dpPrefix.circles}.${circle.id}.places.`) &&
			currentPlaces[i]._id.split(".").length == 6
		) {
			if (!places.some(myPlace => currentPlaces[i]._id.endsWith(myPlace.id))) {
				//  Place no longer exists in Life360 – remove immediately.
				deleteMyObject(currentPlaces[i]._id);
				adapter.log.debug(`Removed ${currentPlaces[i].common.name} from Life360 circle ${circle.name}.`);
			}
		}
	}
}

/**
 * ============================================================================
 * ----------------------------------------------------------------------------
 *      Functions to publish MyPlaces apart from Life360 to ioBroker
 * ----------------------------------------------------------------------------
 * ============================================================================
 */

/**
 *
 * @param {object[]} places
 * @param {object[]} persons
 */
async function publishMyPlaces(places, persons) {
	if (!places) {
		return;
	}

	adapter.log.silly(`Publishing ${places.length} MyPlaces ...`);

	const myTimestamp = Date.now();

	for (const p in places) {
		const myPlace = places[p];
		const dpPlace = `${dpPrefix.myplaces}.${getSantinizedObjectName(myPlace.name)}`;
		const dpPlaceInfo = `${dpPlace}`;
		const dpPlaceMembers = `${dpPlace}`;

		adapter.log.silly(`- MyPlace "${myPlace.name}" ...`);

		//  Create an object and same states for that MyPlace
		await createObjectDP(dpPlace, dpLife360Type.myplace, myPlace.name, myPlace.name);

		//  Update geo positioning information
		const mpLat = Number(myPlace.latitude) || 0;
		const mpLng = Number(myPlace.longitude) || 0;
		const mpRadius = Number(myPlace.radius) || 0;

		await setStateReadOnlyValue(`${dpPlaceInfo}.latitude`, "latitude", "number", "value.gps.latitude", mpLat, true);
		await setStateReadOnlyValue(
			`${dpPlaceInfo}.longitude`,
			"longitude",
			"number",
			"value.gps.longitude",
			mpLng,
			true,
		);
		await setStateReadOnlyValue(
			`${dpPlaceInfo}.gps-coordinates`,
			"gps-coordinates",
			"string",
			"value.gps",
			getGeoLocation(mpLat, mpLng),
			true,
		);
		await setStateReadOnlyValue(`${dpPlaceInfo}.radius`, "radius", "number", "value", mpRadius, true);
		await setStateReadOnlyValue(
			`${dpPlaceInfo}.urlMap`,
			"urlMap",
			"string",
			"text.url",
			getOpenStreetMapUrl(mpLat, mpLng, 15),
			true,
		);
		await setStateReadOnlyValue(
			`${dpPlaceInfo}.urlMapIframe`,
			"urlMapIframe",
			"string",
			"text.url",
			getMapsIframeUrl(mpLat, mpLng, 15),
			true,
		);

		const members = [];
		const membersAtPlace = [];
		let placeCounter = 0;

		if (persons) {
			let regExp = null;
			if (myPlace.circle && myPlace.circle != "") {
				regExp = new RegExp(myPlace.circle);
				adapter.log.debug(`Circle regex pattern: ${regExp.source}`);
			}

			for (const m in persons) {
				const member = persons[m];

				//  Check if person is member of circle only if admin set regex pattern for MyPlace's circle.
				if (!regExp || regExp.test(JSON.stringify(member.memberOf))) {
					const dpMember = `${dpPlaceMembers}.${getSantinizedObjectName(
						`${member.firstName}_${member.lastName}`,
					)}`;
					members.push(`${member.firstName} ${member.lastName}`);

					adapter.log.silly(
						`- MyPlace "${myPlace.name}" -- Member "${member.firstName}_${member.lastName}"...`,
					);

					//  Create an object for that member at that place
					await createObjectDP(
						dpMember,
						dpLife360Type.person,
						`${member.firstName} ${member.lastName}`,
						`${member.firstName} ${member.lastName} @ ${myPlace.name}`,
					);

					//  Calc distance from member to place
					let distance = 0;
					if (member.location) {
						distance = GeoUtils.distanceTo(
							GeoUtils.createLocation(mpLat, mpLng, "LatLng"),
							GeoUtils.createLocation(
								Number(member.location.latitude) || 0,
								Number(member.location.longitude) || 0,
								"LatLng",
							),
						);
					} else {
						// Member has disabled location sharing.
						distance = -1;
					}

					//  Check if member is at that place
					const memberIsAtPlace = !(distance == -1) && distance <= mpRadius;

					if (memberIsAtPlace) {
						placeCounter++;
						membersAtPlace.push(`${member.firstName} ${member.lastName}`);
					}

					//  Get last stored presence information from ioBroker
					let lastPresence = false;
					try {
						lastPresence = Boolean((await adapter.getStateAsync(`${dpMember}.isPresent`)).val);
					} catch {
						lastPresence = false;
					}

					//  Check if presence has changed, respecting optional arrival delay
					const delay = Number(myPlace.isPresentDelay) || 0;

					if (delay > 0) {
						if (memberIsAtPlace) {
							// Person is physically at the place
							if (!lastPresence && !isPresentDelayTimers.has(dpMember)) {
								// Was absent and no timer running yet – start arrival delay timer
								const timerMemberName = `${member.firstName} ${member.lastName}`;
								const timerPlaceName = myPlace.name;
								const timerMemberDpId = `${dpPrefix.people}.${member.id}`;
								locationNamePendingDelay.add(timerMemberDpId);
								const timer = setTimeout(async () => {
									isPresentDelayTimers.delete(dpMember);
									locationNamePendingDelay.delete(timerMemberDpId);
									const miapTimestamp = Date.now();
									await setStateReadOnlyValue(
										`${dpMember}.startTimestamp`,
										"startTimestamp",
										"number",
										"date",
										miapTimestamp,
										true,
									);
									await setStateReadOnlyValue(
										`${dpMember}.isPresent`,
										"Present",
										"boolean",
										"indicator",
										true,
										true,
									);
									// Also update locationName on the person's people state
									locationNameActive.set(timerMemberDpId, timerPlaceName);
									await setStateReadOnlyValue(
										`${timerMemberDpId}.locationName`,
										"locationName",
										"string",
										"text",
										timerPlaceName,
										true,
									);
									// Notify Telegram when person arrives at a MyPlace (after delay)
									await sendLocationNotification(
										timerMemberDpId,
										timerMemberName,
										timerPlaceName,
										"myplace",
									);
									adapter.log.debug(
										`MyPlace "${timerPlaceName}": ${timerMemberName} isPresent=true after ${delay}s delay`,
									);
								}, delay * 1000);
								isPresentDelayTimers.set(dpMember, timer);
								adapter.log.debug(
									`MyPlace "${myPlace.name}": ${member.firstName} ${member.lastName} arrival timer started (${delay}s)`,
								);
							} else if (lastPresence && !isPresentDelayTimers.has(dpMember)) {
								// Person is already confirmed-present (e.g. after adapter restart).
								// The locationNameActive map was cleared on restart, so re-establish
								// the override to prevent publishPeople from overwriting locationName
								// with the Life360 app place name.
								const memberDpId = `${dpPrefix.people}.${member.id}`;
								locationNameActive.set(memberDpId, myPlace.name);
								await setStateReadOnlyValue(
									`${memberDpId}.locationName`,
									"locationName",
									"string",
									"text",
									myPlace.name,
									true,
								);
							}
							// else: timer already running – locationNamePendingDelay handles the guard
						} else {
							// Person is NOT at the place
							if (isPresentDelayTimers.has(dpMember)) {
								// Left before delay elapsed – cancel pending timer
								clearTimeout(isPresentDelayTimers.get(dpMember));
								isPresentDelayTimers.delete(dpMember);
								const cancelledDpId = `${dpPrefix.people}.${member.id}`;
								locationNamePendingDelay.delete(cancelledDpId);
								// Reset locationName to unknown since person passed by without arriving
								if (!locationNameActive.has(cancelledDpId)) {
									await setStateReadOnlyValue(
										`${cancelledDpId}.locationName`,
										"locationName",
										"string",
										"text",
										location_unknown_name,
										true,
									);
								}
								adapter.log.debug(
									`MyPlace "${myPlace.name}": ${member.firstName} ${member.lastName} left before delay elapsed – timer cancelled`,
								);
							}
							if (lastPresence) {
								// Was present → set false immediately
								const miapTimestamp =
									(member.location && Number(member.location.timestamp) * 1000) ||
									new Date().valueOf();
								await setStateReadOnlyValue(
									`${dpMember}.endTimestamp`,
									"endTimestamp",
									"number",
									"date",
									miapTimestamp,
									true,
								);
								await setStateReadOnlyValue(
									`${dpMember}.isPresent`,
									"Present",
									"boolean",
									"indicator",
									false,
									true,
								);
								// Reset locationName override if active
								const memberDpId = `${dpPrefix.people}.${member.id}`;
								if (locationNameActive.get(memberDpId) === myPlace.name) {
									locationNameActive.delete(memberDpId);
									await setStateReadOnlyValue(
										`${memberDpId}.locationName`,
										"locationName",
										"string",
										"text",
										(member.location && member.location.name) || location_unknown_name,
										true,
									);
								}
							}
						}
					} else {
						// No delay – original behavior
						if (lastPresence != memberIsAtPlace) {
							const miapTimestamp =
								(member.location && Number(member.location.timestamp) * 1000) || new Date().valueOf();
							if (memberIsAtPlace) {
								//  Person entered MyPlace
								await setStateReadOnlyValue(
									`${dpMember}.startTimestamp`,
									"startTimestamp",
									"number",
									"date",
									miapTimestamp,
									true,
								);
								// Notify Telegram when person arrives at a MyPlace (no delay)
								await sendLocationNotification(
									`${dpPrefix.people}.${member.id}`,
									`${member.firstName} ${member.lastName}`,
									myPlace.name,
									"myplace",
								);
							} else {
								//  Person left MyPlace
								await setStateReadOnlyValue(
									`${dpMember}.endTimestamp`,
									"endTimestamp",
									"number",
									"date",
									miapTimestamp,
									true,
								);
							}
						}
						//  Update isPresent immediately
						await setStateReadOnlyValue(
							`${dpMember}.isPresent`,
							"Present",
							"boolean",
							"indicator",
							memberIsAtPlace,
							true,
						);
						// Handle locationName override when prioritization is active
						if (prioritizeMyPlacesLocationName) {
							const memberDpId = `${dpPrefix.people}.${member.id}`;
							if (memberIsAtPlace) {
								locationNameActive.set(memberDpId, myPlace.name);
								await setStateReadOnlyValue(
									`${memberDpId}.locationName`,
									"locationName",
									"string",
									"text",
									myPlace.name,
									true,
								);
							} else if (locationNameActive.get(memberDpId) === myPlace.name) {
								// Only reset if THIS place was the one that set the override
								locationNameActive.delete(memberDpId);
								await setStateReadOnlyValue(
									`${memberDpId}.locationName`,
									"locationName",
									"string",
									"text",
									(member.location && member.location.name) || location_unknown_name,
									true,
								);
							}
						}
					}
					await setStateReadOnlyValue(
						`${dpMember}.distance`,
						"Distance",
						"number",
						"value.distance",
						distance,
						true,
					);
					await setStateReadOnlyValue(
						`${dpMember}.timestamp`,
						"timestamp",
						"number",
						"date",
						myTimestamp,
						true,
					);
				}
			}
		}

		//  Update MyPlace stats
		await setStateReadOnlyValue(
			`${dpPlaceInfo}.membersPresentCount`,
			"Counter people present",
			"number",
			"value",
			placeCounter,
			true,
		);
		await setStateReadOnlyValue(
			`${dpPlaceInfo}.membersPresent`,
			"People present",
			"array",
			"list",
			JSON.stringify(membersAtPlace),
			true,
		);
		await setStateReadOnlyValue(
			`${dpPlaceInfo}.membersCount`,
			"Counter people",
			"number",
			"value",
			members.length || 0,
			true,
		);
		await setStateReadOnlyValue(`${dpPlaceInfo}.members`, "People", "array", "list", JSON.stringify(members), true);
		await setStateReadOnlyValue(`${dpPlaceInfo}.timestamp`, "timestamp", "number", "date", myTimestamp, true);

		//  Cleanup stale members
		const currentMembers = await adapter.getChannelsOfAsync("");
		for (let cm in currentMembers) {
			if (currentMembers[cm]._id.startsWith(`${adapter.namespace}.${dpPlace}.`)) {
				if (!members.some(myMember => myMember == currentMembers[cm].common.name)) {
					//  Person no longer present at this MyPlace – remove immediately.
					deleteMyObject(currentMembers[cm]._id);
					adapter.log.debug(`Removed ${currentMembers[cm].common.name} from MyPlace ${myPlace.name}.`);
				}
			}
		}
	}

	//  Cleanup stale MyPlaces
	const currentPlaces = await adapter.getChannelsOfAsync("");
	// const currentPlaces = await adapter.getDevicesAsync();
	for (let cp in currentPlaces) {
		if (
			currentPlaces[cp]._id.startsWith(`${adapter.namespace}.${dpPrefix.myplaces}.`) &&
			currentPlaces[cp]._id.split(".").length == 4
		) {
			if (!places.some(myPlace => myPlace.name == currentPlaces[cp].common.name)) {
				//  MyPlace no longer exists in config – remove immediately.
				deleteMyObject(currentPlaces[cp]._id);
				adapter.log.debug(`Removed ${currentPlaces[cp].common.name} from MyPlaces.`);
			}
		}
	}

	adapter.log.debug(`Published ${places.length} MyPlaces to ioBroker.`);
}

/**
 * Deletes an object and child objects
 *
 * @param {string} objectId The id of the object to remove.
 */
async function deleteMyObject(objectId) {
	if (objectId) {
		//  Delete any states of this object and child states.
		deleteMyStates(objectId);

		//  Delete any child channels of this object.
		deleteMyChannels(objectId);

		//  Delete any child devices of this object.
		deleteMyDevices(objectId);

		//  Delete the object.
		await adapter.delObjectAsync(objectId);
		adapter.log.silly(`Removed object ${objectId} ...`);
	}
}

/**
 * Delete any state objects for a parent object
 *
 * @param {string} parentId The parent object's id.
 */
async function deleteMyStates(parentId) {
	const myObjs = await adapter.getStatesOfAsync();
	const myParentId = parentId.startsWith(adapter.namespace) ? parentId : `${adapter.namespace}.${parentId}`;
	for (let o in myObjs) {
		if (myObjs[o]._id.startsWith(`${myParentId}.`)) {
			await adapter.delObjectAsync(myObjs[o]._id);
			adapter.log.silly(`Removed state ${myObjs[o]._id} ...`);
		}
	}
}

/**
 * Delete any channel objects for a parent object
 *
 * @param {string} parentId The parent object's id.
 */
async function deleteMyChannels(parentId) {
	const myObjs = await adapter.getChannelsOfAsync();
	const myParentId = parentId.startsWith(adapter.namespace) ? parentId : `${adapter.namespace}.${parentId}`;
	for (let o in myObjs) {
		if (myObjs[o]._id.startsWith(`${myParentId}.`)) {
			await adapter.delObjectAsync(myObjs[o]._id);
			adapter.log.silly(`Removed channel ${myObjs[o]._id} ...`);
		}
	}
}

/**
 * Delete any device objects for a parent object
 *
 * @param {string} parentId The parent object's id.
 */
async function deleteMyDevices(parentId) {
	const myObjs = await adapter.getDevicesAsync();
	const myParentId = parentId.startsWith(adapter.namespace) ? parentId : `${adapter.namespace}.${parentId}`;
	for (let o in myObjs) {
		if (myObjs[o]._id.startsWith(`${myParentId}.`)) {
			await adapter.delObjectAsync(myObjs[o]._id);
			adapter.log.silly(`Removed device ${myObjs[o]._id} ...`);
		}
	}
}
