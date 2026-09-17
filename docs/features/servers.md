# Servers

A server is one game world with an owner, a blueprint, an address, and a
lifecycle. Create one from the home page: name it, pick a blueprint, accept
the Minecraft EULA where asked, and press Create.

## What happens on create

The panel checks your quotas first (count, RAM, disk, including what your
other servers already use), claims the next free port starting at 25565,
makes the server directory, and starts downloading in the background. The
status tells you where things stand: `installing`, then `ready` or
`install_failed` with the reason in the audit log. Creation itself stays fast
because the download does not block the response.

## Versions

Change the version any time on the Startup tab, then press Reinstall on the
Settings tab. Reinstall re-downloads for the new version and swaps the
server files. Worlds are kept; configs reset to the blueprint defaults, so
back up first if you hand-tuned anything.

## States that matter

`ready` means installed and manageable. `installing` means downloads are in
flight. `suspended` means an admin froze it: the process is killed and every
mutation is refused until unsuspension. `deleted` is soft: the row stays for
the audit trail while the address is released.

## Deleting

Delete from the Settings tab after typing the server name. A running server
is stopped first so no orphan process keeps its port. The directory stays on
disk for now; database references are released.
