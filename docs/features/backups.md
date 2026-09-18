# Backups

The Backups tab snapshots the whole server directory into a plain `.tar.gz`
you can also open by hand. Every backup is checksummed at creation.

## Creating

Press Back up now. Some blueprints demand a stopped server for a consistent
snapshot; the panel tells you when that applies, otherwise the backup is
marked best-effort. The newest 10 unlocked backups are kept automatically;
older ones are purged. Locked backups are never auto-purged and cannot be
deleted until unlocked.

## Restoring

Restoring replaces the entire server directory with the snapshot: files made
after the backup do not survive, by design. The archive is extracted to a
staging folder first, checksummed, then swapped in, so a failed restore never
leaves a half-old directory. The server must be stopped first.

## Downloading

Any backup can be downloaded as a file. Keep an off-machine copy of the ones
you care about; the panel directory is not a backup strategy by itself.
