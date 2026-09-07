---
source: text
captured: 2025-01-25T19:30:00+05:30
---
# Why we got a 402

A gateway prices a request by max_tokens, before it generates anything.

Sending no cap means the model's own maximum, which is 65536 on Sonnet through
OpenRouter. The gateway multiplies that out, decides the account cannot afford
it, and returns 402 however short the answer would have been.

So DEFAULT_MAX_OUTPUT_TOKENS is 2048 to make requests priceable, not to save
money.
