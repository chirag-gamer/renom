# Changelog

All notable changes to Renom are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning: SemVer.

## [Unreleased]

### Added
- First-run setup: `GET /setup/status` + one-shot `POST /setup/admin` (owner, 12+ char
  password, closes permanently after first user), `npm run setup:admin` CLI, and a
  first-run screen in the web client. The installer asks for the admin account.
- `install.sh`: prompts for listen address/port/data dir, generates the session secret,
  installs, builds, creates the admin, and prints the address to open. Safe to re-run.
- Web client (`apps/panel/public`, no build step): setup, sign-in, and an admin home
  with user list + account creation, in plain language.
- Files API and blueprints catalog API are now served by the panel (routers existed but
  were never mounted); built-in blueprints seed idempotently at boot.

### Fixed
- Full test suite green (75 tests): upgraded vitest 2 → 3 for `node:sqlite` resolution,
  resolved `@renom/contracts` through the workspace build (contracts build before tests),
  deleted stray `registry.js` that shadowed the real blueprint registry module.
- Repository scaffold: Apache-2.0 license, NOTICE, provenance doc, security policy.
- CI pipeline: install, typecheck, lint, unit tests, production build, secret scan (gitleaks),
  dependency audit, SBOM artifact.
- Panel server skeleton: fail-closed environment configuration (SEC-001), structured pino logging
  with secret redaction, request-id middleware (NFR-008), RFC-7807-style error mapping,
  `/healthz` + `/readyz` endpoints (FR-154), 1 MB JSON body bound (SEC-010).
