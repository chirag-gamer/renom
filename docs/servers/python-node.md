# Python and Node apps (experimental)

Not Minecraft at all: plain runtimes for your own code. A Discord bot, a
map renderer, a webhook — anything with an entrypoint.

Tell the panel the entry file on the Startup tab (`main.py`, `index.js`;
the pattern is validated so `../../secrets` never passes). It runs with
your host Python 3 or Node under the server directory, streams console like
any other server, and backs up like any other server.

Experimental because host runtimes vary: if `python` or the file is missing,
starting fails loudly with the reason kept in history. Tunnel through
Playit.gg or Cloudflare per [docs/tunnels.md](../tunnels.md); Minekube is
Java-only.
