---
source: text
captured: 2025-01-07T15:00:00+05:30
---
# Hermes

The sms gateway. One queue per operator, because operators fail independently
and a shared queue turns one operator's outage into everyone's.

Retries are the operator's problem, not ours. We do not retry into a black box.
