---
source: text
captured: 2025-02-01T13:15:00+05:30
---
# Security review findings

Two real ones:

- Device tokens never expire. A token minted for a phone that was lost in 2023
  still works today.
- The admin token lives in an environment variable, so it is in the process
  listing and in every crash dump.

The rest of the report was header advice.
