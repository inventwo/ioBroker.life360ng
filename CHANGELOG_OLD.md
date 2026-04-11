# Older changes
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