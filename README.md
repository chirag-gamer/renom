# Renom

**Run your own game servers from a panel on your own machine.** Renom is a self-hosted
game-server panel: install it, open it in a browser, create your admin account, spin up a
Minecraft server, and manage it — no accounts elsewhere, no third-party logins, no services
you don't control. No public IP? Enable the built-in Minekube tunnel and players join you
by name instead.

Renom grew out of [JTG Panel](https://github.com/JishnuTheGamer/Jtg). It keeps the idea —
one machine, direct `IP:port` networking — and rebuilds the foundations: typed code
throughout, SQLite instead of loose JSON files, passwords that fail closed, and permissions
that default to "no" on every endpoint.

> Status: alpha on the `dev` branch. Install, sign-in, servers, live console, files,
> backups, schedules, tunnels, and admin management all work — follow `CHANGELOG.md`.

## Install it

One command, three choices (install / update / delete):

```bash
curl -fsSL https://raw.githubusercontent.com/chirag-gamer/renom/dev/renom.sh | bash
```

(Prefer to read first? It's short: [`renom.sh`](renom.sh). Or clone and run `./renom.sh`.)

The installer works on a bare machine — it fetches missing basics and Node.js 24+ where
your package manager allows — then asks for a port and your admin account. It listens on
`127.0.0.1` unless you pick your network address, prints the exact URL to open (detecting
your LAN IP when it can), and generates both the session secret and a one-time setup
token. Re-running keeps your data, your secret, and your settings: existing `.env` values
become the prompt defaults.

To start the panel afterwards (your `.env` is picked up automatically):

```bash
npm start --workspace @renom/panel
```

The installer creates the admin, so the first screen you see is the sign-in page. If admin
creation was skipped or failed, the one-time setup screen appears instead — it asks for the
setup token the installer printed.

To update later: choose Update in `./renom.sh` (pulls, rebuilds, restarts). Back up the
`panel.db` file inside your data directory and you can rebuild everything else from
this folder.

## Your first Minecraft server

1. Sign in, create a server, pick **Paper**, tick the Minecraft EULA box.
2. The panel downloads the jar, writes the configs, and marks it ready — watch it happen
   on the Console tab after pressing Start.
3. No public IP? On the Network tab, enable the Minekube tunnel with a name like
   `my-server-1`. After boot, the public address (`my-server-1.play.minekube.net`)
   appears there — share that instead of an IP.

## How sign-in works

Username and password, checked against your own database. Sessions expire, wrong passwords
all look identical (so nobody can probe which accounts exist), and signing in too many
times too fast gets a short cooldown. There is deliberately no "sign in with" button —
your panel shouldn't depend on anyone else's login system to let you into your own servers.

## What's inside

```text
renom.sh                # console dashboard: install / update / delete
install.sh              # the installer it calls
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
- Every server-scoped endpoint checks permissions first and assumes "no". Scoped API keys
  can only narrow access, never widen it.
- All file access goes through one path-confinement check, so a server can't read outside
  its own directory.
- Login attempts, account creation and deletion, suspensions, server lifecycle, backups,
  and schedule runs land in an append-only audit log.
- See [SECURITY.md](SECURITY.md) to report a vulnerability.

## License

[Apache-2.0](LICENSE). Where Renom came from and what it learned from others:
[NOTICE](NOTICE) and [docs/PROVENANCE.md](docs/PROVENANCE.md).

## Thanks

Renom stands on other people's work. Thank you to:

- **[JTG Panel](https://github.com/JishnuTheGamer/Jtg)** — where this started: the
  one-machine panel idea, the installer spirit, and lessons in what to rebuild.
- **[Pterodactyl](https://pterodactyl.io)** (panel, wings, yolks) — the permission-string
  vocabulary, allocations, egg/blueprint concepts, and the server-detail layout
  (console, files, backups, schedules, startup, network, users, settings).
- **[PufferPanel](https://www.pufferpanel.com)** — declarative template ideas.
- **[LinuxGSM](https://linuxgsm.com)** — stop-signal ladder patterns.
- **[Minekube Connect](https://connect.minekube.com)** — the free ingress tunnel that
  lets servers without a public IP welcome players by name.
- **[PaperMC](https://papermc.io)**, **[Purpur](https://purpurmc.org)**, and
  **[Mojang](https://www.minecraft.net)** — the server software this panel boots.
