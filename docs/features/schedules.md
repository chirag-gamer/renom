# Schedules

The Schedules tab runs things on a clock: restarts at 4 AM, backups before
that, a console command to announce it. Each schedule is a cron expression
plus an ordered task list.

## Writing cron

Five fields, UTC: minute, hour, day, month, weekday. `0 4 * * *` is 4 AM
daily. Stars, steps (`*/15`), ranges (`9-17`), and lists (`1,15`) all work;
names like `mon` do not, use numbers. Leap-day schedules work; the panel
looks up to five years ahead for the next run.

## Tasks

Each task is one of three things: a power action (start, stop, restart,
kill), a console command, or a backup. Tasks run in order with an optional
delay between them. A failed task stops the run unless you flagged it to
continue, and every failure lands in the audit log with its reason.

## Safety

Only one run happens at a time per schedule: runs are claimed atomically, so
two panel processes never double-fire, and manual Run now waits its turn
instead of overlapping. Editing a schedule mid-run never loses the edit;
disabling one mid-flight stops it from firing again.
