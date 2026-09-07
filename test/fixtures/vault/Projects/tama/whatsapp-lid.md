---
source: text
captured: 2025-01-26T22:15:00+05:30
---
# The lid problem

WhatsApp chats can be addressed as an opaque id at lid rather than a number at
c.us. The filter asserted c.us, which silently dropped every group message and
half the contacts.

Worse, the digits inside a lid are an internal identifier and match no phone
number, so an allowlist check against them fails for the right person.

The bridge now collects every identifier a message presents and matches on any
of them.
