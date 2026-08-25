# Renom

**Renom** is a simpler, cleaner, safer evolution of [JTG Panel](https://github.com/JishnuTheGamer/Jtg)
— a self-hosted game-server management panel for one machine, built on TypeScript, Node.js,
React/Vite, Express, Socket.IO and SQLite, with Docker isolation behind an engine interface.

> Status: pre-release development (`dev` branch). See `CHANGELOG.md` for progress and
> `docs/` for architecture and operations documentation.

## Product goals

1. **Simple** — one-machine install, direct `IP:port` networking by default, zero external services.
2. **Clean** — typed modular-monolith domain boundaries, declarative blueprints, SQLite persistence.
3. **Safe** — deny-by-default authorization, path confinement, bounded ingress, audited mutations.

Pterodactyl-inspired capabilities are adopted selectively: admin/user separation, servers with
lifecycle states, allocations, blueprints with validated variables, console, files, backups,
schedules, subusers/RBAC, audit logs and scoped API keys. Tunnels (playit.gg/frp) are optional,
off-by-default adapters and are never required for core lifecycle.

## Repository layout

```text
apps/panel            # panel application (server + web client)
packages/contracts    # shared zod schemas + TS types used by server and client
docs/                 # architecture, operations, extension specs
scripts/              # installer assets, CLIs (import-jtg, create-owner)
```

## Development

Requires Node.js >= 24 (uses the built-in `node:sqlite` driver — no native build tools needed).

```bash
npm install
npm run build        # type-check + build server and client
npm run lint         # eslint + prettier check
npm test             # unit tests (vitest)
npm run dev          # server (tsx watch) + client (vite)
```

Health endpoints: `GET /healthz` (liveness), `GET /readyz` (readiness: db + engine).

## Security

See [SECURITY.md](SECURITY.md) for the supported-version policy and vulnerability disclosure
process. Hard requirements baked into the product: no default production secrets (startup fails
closed), deny-by-default permissions on every server-scoped route, single path-confinement utility
for all filesystem access, bounded request bodies/uploads, append-only audit log.

## License

[Apache-2.0](LICENSE). Derivative provenance and attribution: see [NOTICE](NOTICE) and
[docs/PROVENANCE.md](docs/PROVENANCE.md).
