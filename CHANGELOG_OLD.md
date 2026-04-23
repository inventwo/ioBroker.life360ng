# Older changes
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