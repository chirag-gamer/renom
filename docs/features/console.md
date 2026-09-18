# Console

The Console tab streams your server's live output and takes input. It works
over a WebSocket at the same origin (`/socket.io/`, authenticated with your
bearer token, never a URL query) that checks the same rules as the API:
strangers get nothing, collaborators need the console permission, and
suspended servers stream nothing at all.

## What you see

The last 500 lines are kept per server. Opening the tab loads recent history
first, then live lines append as they arrive. A slow client is dropped
rather than buffered forever. Every payload carries a `{v: 1}` envelope so
clients can evolve.

## Revocation cuts the stream

Removing a collaborator, suspending a user or server, or revoking an API key
cuts matching live subscriptions immediately. The tab says access changed
instead of going silently stale.

## Limits

Input is budgeted per person per server (20 commands per 10 seconds across
all your tabs, not per tab), and each message carries exactly one command:
control characters are stripped centrally. Automation should use the REST
endpoint instead: `POST /servers/:id/console/send`.

## Power

Start, Restart, Stop, and Kill sit above the console. Stop is graceful first
(the blueprint's stop command, then a signal, then kill after its timeout).
Kill is immediate, and refuses to lie: if the process survives, the server
stays marked instead of pretending to be offline. Each action has its own
permission, so a collaborator can be allowed to start without being allowed
to kill.

If the executable is missing or crashes in the first second, starting fails
loudly instead of pretending to run. The history keeps the evidence.

## A note on sign-in storage

The browser keeps your session token in session storage (per tab, gone on
close) rather than a cookie. That keeps the panel working without cookie or
CSRF machinery, at the cost that any script running on the page could read
it. The page serves no third-party scripts, and the security headers block
framing and MIME sniffing, which is what makes the tradeoff acceptable.
