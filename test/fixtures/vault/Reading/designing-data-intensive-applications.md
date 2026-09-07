---
source: text
captured: 2025-01-12T21:30:00+05:30
---
# DDIA

Chapter 5, replication. The thing that stuck: leaderless replication trades
write availability for read repair complexity. You get to keep writing when a
node is down, and you pay for it forever afterwards in reconciliation logic.
