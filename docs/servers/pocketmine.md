# PocketMine-MP (experimental)

The PHP Bedrock server with the biggest plugin ecosystem, handled the
Pterodactyl way: the panel downloads the server phar from the latest GitHub
release plus a matching static PHP 8.4 binary for your OS, so no system PHP
is needed.

It boots as `bin/php/php PocketMine-MP.phar --no-wizard` and speaks UDP on 19132. Plugins are `.phar` files dropped in `plugins/`. Like all Bedrock
software here, it tunnels through Playit.gg or Cloudflare, not Minekube;
see [docs/tunnels.md](../tunnels.md).
