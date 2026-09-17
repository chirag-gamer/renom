# Bedrock Dedicated Server (experimental)

The official Mojang Bedrock server, for phones, consoles, and Windows
players. Marked experimental while Bedrock boots get more verification.

No Java needed: it is a native binary. The panel resolves your version
through the EndstoneMC registry (URLs plus SHA256, no guessing), downloads
the zip for your OS, and extracts it. Windows and Linux x64 are covered.

Bedrock speaks UDP: the default allocation is port 19132. The Minekube
tunnel does not apply (it ships a Java plugin), so for public play without
an IP, run Playit.gg or Cloudflare next to the panel; see
[docs/tunnels.md](../tunnels.md).
