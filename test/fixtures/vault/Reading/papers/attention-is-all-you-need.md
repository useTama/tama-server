---
source: text
captured: 2025-02-02T20:00:00+05:30
---
# Attention Is All You Need, reread

The thing I had forgotten is that the positional encoding is added to the
embedding, not concatenated with it. Which means the model has to learn to
separate position from meaning inside the same vector.
