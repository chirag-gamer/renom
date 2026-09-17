# Endstone (experimental)

Endstone is Paper for Bedrock: a high-performance Bedrock server you extend
with Python (or C++) plugins instead of PHP. It runs with `pip install
endstone` followed by `endstone`.

Needs Python 3.10+ on the host: the panel installs the package globally at
your explicit choice of this blueprint, then launches the `endstone`
entrypoint. Python plugins live in `plugins/`. Bedrock networking applies
(UDP 19132), and like the rest of Bedrock it tunnels through Playit.gg or
Cloudflare; see [docs/tunnels.md](../tunnels.md).

Experimental because host Pythons vary: if your first boot fails, the
console keeps the pip error and the install status says so.
