# API keys

API keys let scripts act as you, with less power than you. Create one from
your account with a memo and a scope list. The secret shows exactly once;
after that only its hash exists in the database.

## Scopes narrow, never widen

A key intersects your own permissions. An owner's `file.read` key can read
files and nothing else: it cannot start servers, create accounts, mint wider
keys, or touch admin routes. Key management itself (list, mint, revoke)
needs your session or a full `*` key; narrowed keys inherit none of it.

## Long-lived by design

Changing your password does not kill your keys. Keys have their own
lifetime: expiry dates plus immediate revocation. If a password change is
meant to cut everything off, revoke the keys too; the audit trail shows
which key acted, so you know what to cut.

## Using one

Send it as the bearer token where you would send a session JWT. The panel
treats it the same everywhere else, including the audit trail, which records
which key acted.
