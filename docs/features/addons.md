# Addons (mods and plugins)

The Addons tab installs server software from Modrinth, the way the old JTG
workflow did, minus the blind downloads: every file is pinned to your exact
game version and loader, checksum-verified, and jar-only.

## Installing

Pick an exact Minecraft version on the Startup tab first ("latest" cannot
resolve files), then type project ids like `lithium, phosphor` and press
Install. Fabric and Forge servers receive mods in `mods/`; Paper, Purpur,
and Velocity servers receive plugins in `plugins/`. Restart to activate.

## Removing

Each entry has Remove. Deleting the file is immediate; the running server
keeps using its loaded copy until restart.

## Limits

Vanilla has no mod platform and refuses. Bedrock, Python, and Node servers
are outside Modrinth's loader set and refuse too. Ten projects per request;
repeat for more.
