# Tunnels: playing without a public IP

Most home connections have no public IP, so players cannot reach your server
by address. Renom handles this two ways: built in for Java, do it yourself
for everything else.

## Java servers: Minekube, built in

Paper, Purpur, Vanilla, Fabric, Forge, and Velocity servers can use the
Minekube Connect tunnel from the Network tab:

1. Type an endpoint name like `my-server-1` and press Enable.
2. The panel installs the Connect plugin into your server and restarts it
   with that name.
3. After boot, your public address appears on the same tab, shaped like
   `my-server-1.play.minekube.net`. Share that. Players join it on the
   normal port, Java and Bedrock alike.

Two things to know. First, Minecraft 1.19 and newer must have
`enforce-secure-profile=false` in server.properties or tunnelled players get
rejected at login. Second, the tunnel is optional and off until you enable
it. Nothing about install, start, or stop depends on it.

## Bedrock, Python, and Node servers: bring your own tunnel

Minekube ships a Java plugin, so it cannot run on Bedrock, Python, or Node
servers. For those, run a tunnel yourself next to the panel. Two solid
options:

### Playit.gg

1. Create an account at playit.gg and install their agent on the same
   machine as the panel.
2. In the Playit dashboard, add a tunnel pointing at your server's
   allocation (the IP and port shown on the Network tab).
3. Playit gives you a public address. Share that instead of your IP.

### Cloudflare Tunnel (cloudflared)

1. Install `cloudflared` on the panel machine and log in (`cloudflared login`).
2. Expose the game port, for example:
   `cloudflared tunnel --url tcp://localhost:25565`
   (use UDP where the game needs it; Bedrock is UDP-first).
3. Cloudflare prints a public hostname. Share that.

Whichever you pick, the panel does not care: your server keeps starting,
stopping, and backing up exactly the same. The tunnel only moves packets.
