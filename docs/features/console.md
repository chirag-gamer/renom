# Console

The Console tab streams your server's live output and takes input. It works
over a WebSocket that authenticates the same way as the API: strangers get
nothing, collaborators need the console permission, and suspended servers
stream nothing at all.

## What you see

The last 500 lines are kept per server. Opening the tab loads recent history
first, then live lines append as they arrive. Input rate is limited (30
commands per 10 seconds per connection); automation should use the REST
endpoint instead: `POST /servers/:id/console/send`.

## Power

Start, Restart, Stop, and Kill sit above the console. Stop is graceful first
(the blueprint's stop command, then a signal, then kill after its timeout).
Kill is immediate. Each action has its own permission, so a collaborator can
be allowed to start without being allowed to kill.

If the executable is missing or crashes in the first second, starting fails
loudly instead of pretending to run. The history keeps the evidence.
