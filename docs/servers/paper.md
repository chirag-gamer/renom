# Paper

High-performance Java server from PaperMC. This is the default recommendation:
fast, stable, plugin-friendly, and the one we boot-test on every change.

Needs Java 21+ on the host and an accepted Minecraft EULA (the checkbox at
creation). The panel resolves the newest stable build for your version
through PaperMC Fill v3, verifies its checksum, writes `server.properties`
with your port, and boots `java -jar paper.jar nogui`.

Plugins go in `plugins/` by hand or through the Addons tab. Minekube tunnel
supported from the Network tab.
