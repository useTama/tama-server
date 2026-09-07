---
source: text
captured: 2025-01-20T14:45:00+05:30
---
# Events table migration

Moving the events table off RDS and onto Timescale.

The blocker is that the events table has no primary key. It was created by a
script in 2022 with no constraints at all, so logical replication cannot
identify a row to update, and the migration tool refuses to start.

Adding a key to 900 million rows is its own project.
