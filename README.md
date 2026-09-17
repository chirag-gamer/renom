# Renom

**Run your own game servers from a panel on your own machine.** Renom is a self-hosted
game-server panel: install it, open it in a browser, create your admin account, and manage
servers — no accounts elsewhere, no third-party logins, no services you don't control.

Renom grew out of [JTG Panel](https://github.com/JishnuTheGamer/Jtg). It keeps the idea —
one machine, direct `IP:port` networking — and rebuilds the foundations: typed code
throughout, SQLite instead of loose JSON files, passwords that fail closed, and permissions
that default to "no" on every endpoint.

> Status: early alpha on the `dev` branch. The panel installs, you can sign in, and admins
> can manage accounts. Server lifecycle (start/stop/console/files) lands in the next slices —
> follow `CHANGELOG.md`.

## Install it

You need one thing: **Node.js 24 or newer**. Then:

```bash
git clone https://github.com/chirag-gamer/renom.git
cd renom
./install.sh
```

The installer asks three small questions — where the panel should listen, which port, where
to keep its data — then asks you to create the admin account. When it finishes, it tells
you the exact address to open. That first screen you see is a one-time setup: once the
admin exists, it never appears again, and every further account is created from inside
the panel by an admin.

To start the panel afterwards:

```bash
npm start --workspace @renom/panel
```

To update later: `git pull`, re-run `./install.sh` (it keeps your data and your secret),
restart. Back up the `panel.db` file inside your data directory and you can rebuild
everything else from this folder.

## How sign-in works

Username and password, checked against your own database. Sessions expire, wrong passwords
all look identical (so nobody can probe which accounts exist), and signing in too many
times too fast gets a short cooldown. There is deliberately no "sign in with" button —
your panel shouldn't depend on anyone else's login system to let you into your own servers.

## What's inside

```text
install.sh              # the installer above
apps/panel              # the panel: API server + the web pages it serves
apps/panel/public       # those web pages (plain HTML/CSS/JS, no build step)
packages/contracts      # shared request/response shapes used by server and client
docs/                   # provenance, architecture, operations notes
```

```bash
npm run build        # type-check + build
npm run lint         # eslint + prettier check
npm test             # tests (vitest)
npm run dev          # live-reload server for development
```

Health endpoints: `GET /healthz` (is it alive), `GET /readyz` (is the database reachable).

## Security notes worth knowing

- Production refuses to start without a long `JWT_SECRET` — the installer generates one.
  No default passwords, no default secrets, anywhere.
- Every server-scoped endpoint checks permissions first and assumes "no".
- All file access goes through one path-confinement check, so a server can't read outside
  its own directory.
- Every login, account change and suspension lands in an append-only audit log.
- See [SECURITY.md](SECURITY.md) to report a vulnerability.

## License

[Apache-2.0](LICENSE). Where Renom came from and what it learned from others:
[NOTICE](NOTICE) and [docs/PROVENANCE.md](docs/PROVENANCE.md).
