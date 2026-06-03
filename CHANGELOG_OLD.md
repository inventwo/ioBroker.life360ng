# Older changes
## 1.9.1 (2026-05-20)
- (skvarel) Fixed tracker map showing wrong day (yesterday's route) for users in timezones ahead of UTC: date calculations now use local time instead of UTC, preventing GPS points and the default date range from being assigned to the previous day between midnight and the UTC offset hour
- (skvarel) Reduced risk of Cloudflare rate-limiting: API retry loops now abort immediately on a 403/503 block instead of hammering the API with further requests; added a short delay between consecutive API calls within each poll cycle

## 1.9.0 (2026-05-18)
- (skvarel) Added place-specific notification overrides table in the Notifications tab: configure custom arrival and leave messages per place and person, with optional suppression of the default standard message; place and person columns use dropdowns populated from known places and Life360 persons

## 1.8.0 (2026-05-17)
- (skvarel) Fixed unhandled promise rejections ("DB closed") at adapter shutdown caused by async DB operations running after the Redis connection was already closed; adapter now sets an unloading flag to prevent new operations from starting and catches any remaining DB errors gracefully
- (skvarel) Added Notifications tab with Telegram support: send a message when a person arrives at a known place (Life360 app places, own places and/or unknown places); configurable per person with prefix text and per recipient with instance number and Chat ID
- (skvarel) Added Alexa announcements support: announce location arrivals via Amazon Echo devices using the ioBroker Alexa2 adapter; configurable device list with speak state ID and announcement volume (volume is automatically restored by the Alexa adapter after each announcement)

## 1.7.0 (2026-05-14)
- (skvarel) Fixed crash on fresh install caused by adapter writing tracker files before the namespace meta object was created
- (skvarel) Improved error message when Life360 API requests are blocked by Cloudflare (IP rate-limited); no longer logs the full HTML response
- (skvarel) Hovering over a route point or line now temporarily highlights the active day (thicker line, full opacity, other days faded) when "Day highlight" is enabled; the tooltip on a line shows date (person map) or name and date (circle map)
- (skvarel) Clicking a line now opens a single popup at the cursor position with date and name instead of opening all marker popups
- (skvarel) Added optional radius circles for Life360 places and own places (My Places) on the tracker map; toggleable via new "Place radius" and "My Place radius" checkboxes in the hamburger menu; circles use the same color as the flag markers
- (skvarel) Updated documentation
- (skvarel) Added per-person minimum distance setting to the tracker table; a value of 0 falls back to the global minimum distance

## 1.6.0 (2026-05-12) 
- (skvarel) Added refresh button to the hamburger menu
- (skvarel) Clicking a route point in multi-day view now highlights the active day (thicker line, full opacity) while other days fade into the background; all timestamps for the selected day open simultaneously; clicking the map background or the same point again resets the view
- (skvarel) Added "Day highlight" toggle to the hamburger menu to switch between single-popup and day-highlight mode; state persists per map in the browser
- (skvarel) Reduced popup size (smaller font and padding) for a less dominant appearance
- (skvarel) Added configurable popup opacity in the Map Display settings (default: 1.0)
- (skvarel) Active day highlight and open popups are restored after auto-refresh
- (skvarel) Added configurable default view range for the date picker; the map opens showing the last N days by default on every load

## 1.5.2 (2026-05-10)
- (skvarel) Added configurable opacity for flag markers (Life360 places and own places)

## 1.5.1 (2026-05-10)
- (skvarel) Extracted shared map JS and CSS from HTML tracker files into static files served once by the web adapter, reducing the size of each GPS-update HTML file significantly
- (skvarel) Fixed JSDoc type warnings introduced by updated ESLint config (jsdoc/reject-any-type, jsdoc/reject-function-type)
- (skvarel) Added documentation for tracker file storage location (Admin → Files → life360ng.<instance>/tracker/)
- (skvarel) Added separate docs page for the Map Display tab (colors, route style, place flags, layout) in English and German; moved map appearance content out of the Logbook docs page

## 1.5.0 (2026-05-10)
- (skvarel) Added flag markers for Life360 places and own places (MyPlaces) to all tracker maps, configurable color, size and visibility per source
- (skvarel) Map legend now hides automatically when the route checkbox is unchecked, on both person and circle maps
- (skvarel) Removed the separate "Show map legend" checkbox – legend visibility is now controlled via the route checkbox
- (skvarel) Moved map appearance settings (colors, markers, flags, layout) to a dedicated "Map Display" tab in admin config
- (skvarel) Replaced header checkboxes with a hamburger menu (☰) on all tracker maps; Route, Places, Footer and Map Size are now toggleable directly in the map; footer and map-size preferences are stored per map in the browser
- (skvarel) Map no longer auto-zooms after a data refresh when the user has manually panned or zoomed; the chosen view is kept until the tab or window is closed

## 1.4.0 (2026-05-07)
- (skvarel) Added additional local map URL per person and circle map with the ioBroker server IP and web adapter port
- (skvarel) Added configurable arrival delay (seconds) per MyPlace – `isPresent` is only set to `true` after the person has been inside the radius for the configured time; leaving sets it to `false` immediately
- (skvarel) Added `locationName` delay for persons at MyPlaces: after the arrival delay `people.<id>.locationName` is set to the MyPlace name; on departure it is reset immediately to the Life360 location name
- (skvarel) Added option to prioritize My Places name for `locationName` over the Life360 location name (configurable checkbox in My Places tab)
- (skvarel) Added language-dependent documentation link in the Help tab of the admin config

## 1.3.1 (2026-05-04)
- (skvarel) Added option to deactivate/activate map size in the footer at config

## 1.3.0 (2026-05-04)
- (skvarel) Added optional map legend footer to tracker maps showing start, waypoint, current position markers and map size
- (skvarel) Switched HTML maps to bilingual - english and german

## 1.2.3 (2026-05-03)
- (skvarel) Fixed circle map header name

## 1.2.2 (2026-05-03)
- (skvarel) Modified map - Endpoint of the past days as a dot instead of a pin

## 1.2.1 (2026-05-02)
- (skvarel) Modified map pin with opacity and size

## 1.2.0 (2026-05-01)
- (skvarel) Added GPS route tracking with per-person and family map (OpenStreetMap)
- (skvarel) Added adapter documentation

## 1.1.0 (2026-04-23)
- (skvarel) Fixed invalid object hierarchy (device under channel)
- (skvarel) Removed dependency on Places adapter
- (skvarel) NOTE: Delete all adapter objects after updating (see Migration Notes)

## 1.0.21 (2026-04-13)
- (skvarel) Improved help tab in the config
- (skvarel) Added new screenshots of browser DevTools

## 1.0.20 (2026-04-13)
- (skvarel) Removed react and mui
- (skvarel) Edit readme

## 1.0.19 (2026-04-12)
- (skvarel) Translations adjusted

## 1.0.18 (2026-04-12)
- (skvarel) Fixed info.connection role in io-package.json
- (skvarel) Removed @ts-nocheck and unused variable from lib files; fixed CRLF line endings
- (skvarel) ESLint now covers all lib files with strict no-warnings enforcement
- (skvarel) Added Copilot instructions for guided development

## 1.0.17 (2026-04-12)
- (skvarel) Configuration revised, translations adjusted and repo cleaned up

## 1.0.16 (2026-04-12)
- (skvarel) Modernized config

## 1.0.15 (2026-04-12)
- (skvarel) Added FAQ tab at config

## 1.0.14 (2026-04-11)
- (skvarel) Modernized config

## 1.0.13 (2026-04-11)
- (skvarel) Modernized config

## 1.0.12 (2026-04-11)
- (skvarel) Fixed invalid JSON in zh-cn translation

## 1.0.11 (2026-04-11)
- (skvarel) Added configurable fallback text for `locationName` when a person is not at a known place

## 1.0.10 (2026-04-11)
- (skvarel) Added configurable fallback text for `locationName` when a person is not at a known place

## 1.0.9 (2026-04-11)
- (skvarel) Revised translation

## 1.0.8 (2026-04-11)
- (skvarel) Added notes regarding the token

## 1.0.7 (2026-04-11)
- (skvarel) Fixed adapter turning green on invalid token — instance now shows yellow when no data is received from Life360 cloud services

## 1.0.6 (2026-04-11)
- (skvarel) Adapter cleanup

## 1.0.5 (2026-04-11)
- (skvarel) Removed old not needed images

## 1.0.4 (2026-04-11)
- (skvarel) Changed icons from mdi to base64

## 1.0.3 (2026-04-11)
- (skvarel) Added icons to config

## 1.0.2 (2026-04-11)
- (skvarel) Migrated HTTP requests from deprecated request package to native node:https
- (skvarel) Removed bluebird, request, retry-request and uuid dependencies
- (skvarel) Added Ukrainian translation
- (skvarel) Fixed io-package.json schema errors and updated minimum dependencies
- (skvarel) Added Dependabot configuration and auto-merge rules
- (skvarel) Modernized GitHub workflows

## 1.0.1 (2026-04-11)
- (skvarel) Fixed some repo-checker errors

## 1.0.0 (2026-04-10)
- (skvarel) Fork from ioBroker.life360, renamed to life360ng
- (skvarel) Switched to token-only authentication (removed password/phone login)
- (skvarel) Fixed EU API connectivity (TLS cipher fix, v3 endpoints for members and places)
- (skvarel) Added `locationName` state
- (skvarel) Removed unused phone/password/countryCode config fields