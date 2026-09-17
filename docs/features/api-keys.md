# API keys

API keys let scripts act as you, with less power than you. Create one from
your account with a memo and a scope list. The secret shows exactly once;
after that only its hash exists in the database.

## Scopes narrow, never widen

A key intersects your own permissions. An owner's `file.read` key can read
files and nothing else: it cannot start servers, create accounts, mint wider
keys, or touch admin routes. A key can mint new keys only inside its own
scope ceiling. Keys expire when you say so and die immediately on revoke.

## Using one

Send it as the bearer token where you would send a session JWT. The panel
treats it the same everywhere else, including the audit trail, which records
which key acted.
