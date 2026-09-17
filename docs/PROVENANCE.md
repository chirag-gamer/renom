# Provenance

Renom is an evolution of **JTG Panel** (`JishnuTheGamer/Jtg`, snapshots `11f0907a27a78febbc86c142ccc580035cff9dba`
(2026-08-25) and `f8900ee5256d93c12508013f0a81d3036ca95a34` (2026-09-10)). The upstream author has
granted consent for derivative use: recorded by the project owner 2026-08-25 and re-affirmed
2026-09-17 (covers the current upstream snapshot). Renom is distributed under Apache-2.0.

## Relationship to upstream

| Aspect           | Status                                                                                                          |
| ---------------- | --------------------------------------------------------------------------------------------------------------- |
| Stack continuity | Kept: TypeScript end-to-end, Node.js, Express, Socket.IO, React/Vite, Docker isolation                          |
| Persistence      | Replaced: JSON files -> SQLite (built-in `node:sqlite`) behind a repository interface                           |
| Auth model       | Replaced: fail-closed secrets, local username/password only (no third-party login), no runtime account creation |
| Authorization    | Replaced: deny-by-default permission strings enforced at every endpoint/room                                    |
| Filesystem       | Replaced: single confinement utility for all operations                                                         |
| Data continuity  | `scripts/import-jtg` migrates existing JTG `.data` installs (users/servers/ports/backups)                       |

Known upstream vulnerabilities (auth bypass via port check, unauthenticated Google identity trust,
missing authorization on 20+ endpoints, arbitrary write/SSRF, defective path containment, shell
injection, hardcoded JWT fallback, Docker socket proxy agent) are eliminated structurally; each maps
to a requirement ID (SEC-001..017) with tests.

## Conceptual references (no code copied)

- Pterodactyl panel/wings/yolks (MIT) - permission vocabulary, allocations, egg/blueprint concepts,
  stop ladder.
- PufferPanel (Apache-2.0) - template schema ideas.
- LinuxGSM (MIT) - stop-signal patterns.

Vendored third-party snippets (if any ever appear) must carry their license header verbatim and be
registered in this file.
