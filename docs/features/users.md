# Users and collaborators

Two different things live under people. Panel accounts (the admin home page)
are logins: username, password, role, quotas, suspension. Collaborators (the
Users tab on a server) are grants: one account gets a named set of
permissions on one server.

## Roles

Owner, admin, user. The owner is the first account, made once at install.
Admins manage accounts and every server. Users see only their own servers
unless invited elsewhere.

## Grants

Invite by username plus a comma list like `control.console,file.read`. The
panel refuses anything outside the grantor's own permissions, so a
collaborator can never hand out `*` or anything they lack. Removing the grant
detaches them immediately; suspending the server freezes them out until it
is lifted.

## Quotas and suspension

Each account carries a server count, RAM, and disk quota, enforced against
live usage at creation time. Suspending an account blocks its logins and
invalidates its sessions; suspending a server kills its process and refuses
every mutation on it.
