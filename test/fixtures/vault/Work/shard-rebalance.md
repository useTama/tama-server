---
source: text
captured: 2025-01-24T11:20:00+05:30
---
# Shard rebalance

The cache warmer began timing out the week the shard count went from 4 to 12.
The warmer walks shards one at a time, so the cache work is eighty seconds
inside a thirty second limit and it is timing out before the last five.

Two at a time would fit. Nobody has done it because that script has no owner.
