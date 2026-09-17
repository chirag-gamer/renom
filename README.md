# Renom

Run game servers from a panel on your own machine. No rented panel, no
per-server fees, no account with someone else just to reach your own
computer. You install Renom, open it in a browser, and it manages what is
already yours.

Today that means Minecraft. Java servers (Paper, Vanilla, Purpur) install
and boot with one click. Bedrock servers (official BDS, PocketMine-MP,
Endstone) and plain Python or Node apps are marked Experimental while they
earn the same trust. Players without a public IP join Java servers by name
through the built-in tunnel; everyone else gets clear directions for
Playit.gg or Cloudflare.

## Install it

One command, three choices (install, update, delete):

```bash
curl -fsSL https://raw.githubusercontent.com/chirag-gamer/renom/dev/renom.sh | bash
```

Read [`renom.sh`](renom.sh) first if you like. It is short on purpose. The
installer works on a bare machine, asks for a port and an admin account,
then prints the exact address to open. Re-running keeps your data and
settings.

Start the panel with:

```bash
npm start --workspace @renom/panel
```

## Your first server

Sign in, press Create, pick Paper, tick the Minecraft EULA box. The panel
downloads the jar, writes the configs, and marks the server ready. Press
Start and watch the console. That is the whole onboarding.

Versions change on the Startup tab plus Reinstall on Settings. Mods and
plugins come from the Addons tab (Modrinth, checksum-verified). Backups,
schedules, files, and collaborators each have their own tab, and the admin
home manages accounts.

## Where this is going

Renom starts with Minecraft because that is what we can boot and verify
today. Next, in rough order:

- [ ] Rust (oxide plugins, RCON console)
- [ ] Palworld (dedicated server, settings editor)
- [ ] ARK: Survival Ascended
- [ ] Counter-Strike 2 (community servers, workshop maps)
- [ ] Valheim (plus crossplay notes)
- [ ] Terraria (TShock support)
- [ ] Docker engine, so Fabric, Forge, and Velocity boot anywhere

Each game lands the same way: a blueprint, a verified boot, a doc page, and
an honest maturity label. Nothing ships as stable before it boots here.

## Not yet built

SFTP access, multi-machine nodes, and non-UTC schedule timezones. The README
says when they land; until then they are absent, not half-working.

## How sign-in works

Username and password against your own database. Wrong passwords all look
identical, so nobody can probe which accounts exist. Too many tries earns a
short cooldown. There is no Sign in with button and never will be: your
panel should not need someone else's login system to let you into your own
servers.

## Security notes worth knowing

Production refuses to start without a long secret, which the installer
generates. Every endpoint assumes no until permissions say yes, and scoped
API keys can only narrow access. All file access stays inside the server
directory. Logins, account changes, lifecycle, backups, and schedule runs
land in an append-only audit log. Report holes per [SECURITY.md](SECURITY.md).

## For developers

```bash
npm run build        # type-check + build
npm run lint         # eslint + prettier check
npm test             # tests (vitest)
npm run dev          # live-reload server for development
```

`GET /healthz` answers whether it lives, `GET /readyz` whether the database
is reachable. Feature docs live in [`docs/features`](docs/features), each
game server in [`docs/servers`](docs/servers), tunnels in
[`docs/tunnels.md`](docs/tunnels.md).

## License

[Apache-2.0](LICENSE). Provenance and attribution: [NOTICE](NOTICE) and
[docs/PROVENANCE.md](docs/PROVENANCE.md).

## Thanks

Renom stands on other people's work:

- **JTG Panel** (https://github.com/JishnuTheGamer/Jtg): where this started,
  with the author's permission for derivative use.
- **Pterodactyl** (https://pterodactyl.io): permission vocabulary,
  allocations, egg and blueprint concepts, and the server detail layout.
- **PufferPanel** (https://www.pufferpanel.com): declarative template ideas.
- **LinuxGSM** (https://linuxgsm.com): stop-signal patterns.
- **Minekube Connect** (https://connect.minekube.com): the free tunnel for
  servers without a public IP.
- **PaperMC** (https://papermc.io), **Purpur** (https://purpurmc.org),
  **PocketMine-MP** (https://pmmp.io), **Endstone** (https://endstone.dev),
  and **Mojang** (https://www.minecraft.net): the server software this panel
  boots.
