---
source: text
captured: 2025-01-27T16:20:00+05:30
---
# Where the p95 actually goes

It is not the database. Query time is 12ms at p95 and has not moved in a month.

It is the json serialiser on the list endpoint, which does an n+1 on tags: one
query per row to fetch the tag names, 50 rows a page. The database is fast and
we make 51 round trips to it.

Eager load the tags and the whole thing collapses.
