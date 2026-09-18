# Vanilla (Java)

The official Mojang server, straight from the version manifest. Nothing
added, nothing tuned: pick this when you want the game exactly as Mojang
ships it, or as a baseline to compare other software against.

Needs Java 21+ and the EULA checkbox. The panel fetches the server jar for
your version with its SHA1 verified, writes `server.properties`, and boots
`java -jar server.jar nogui`. No plugins exist for vanilla; datapacks go in
`world/datapacks/` by hand. Minekube tunnel supported.
