---
source: text
captured: 2025-01-26T15:45:00+05:30
---
# Platform odds and ends

Eviction on the redis cache is allkeys-lru, which is wrong for us. Half of what
that cache holds is session state, and session state should not be the first
thing dropped when a box comes under memory pressure. The other half is cheap
to recompute and could be dropped all day without anybody noticing.

Vendor review is due in March. The contract renews automatically unless someone
sends notice thirty days out, which is the kind of date nobody owns until it
has already passed once. Anand has the paperwork from last year somewhere. The
cache vendor is on the same renewal date, which is worth knowing before anyone
argues about the line item again.

The office move is still pencilled in for the second week of April. Facilities
want a floor plan by the end of the month and nobody has asked the team where
they would rather sit, which is how the last move went wrong.

Anand also wrote a warmer for the search index over the weekend. It is a good
warmer, and it should live in the repo rather than on his laptop, because the
next person who needs one will not think to ask him for it.

The board deck needs the reliability slide redone. Last quarter's version used
the old error budget and the numbers on it have not been true since November.

The payments health check keeps timing out at midnight. That is the backup
window timing out rather than the service, and a check that fails on a schedule
is not an incident. The alert has cried wolf four times now.
