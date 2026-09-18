# Game servers in Renom

Every server is a blueprint plus your choices. Java first, Bedrock next,
plain runtimes after that. Stable means boot-verified here; experimental
means declared, wired, and honest about what still needs proving.

## Stable

- [Paper](paper.md): the default Java server.
- [Vanilla](vanilla.md): official Mojang Java server.
- [Purpur](purpur.md): Paper with deep gameplay config.

## Experimental

- [Bedrock Dedicated Server](bedrock.md): official Mojang Bedrock server.
- [PocketMine-MP](pocketmine.md): PHP Bedrock server, PHP binary included.
- [Endstone](endstone.md): Python Bedrock server, needs host Python 3.10+.
- [Fabric and Forge](fabric-forge.md): Java mod loaders (Docker for now).
- [Velocity](velocity.md): Java proxy (Docker for now).
- [Python and Node apps](python-node.md): your own code with an entrypoint.

Tunnels: Java servers use built-in Minekube; everything else follows
[tunnels.md](../tunnels.md).
