---
source: text
captured: 2025-01-13T16:04:00+05:30
---
# Kubeflow cost

The gpu node pool costs about 1400 dollars a month sitting idle because the
autoscaler minimum is set to 1 and nobody set it back after the December crunch.

Setting the minimum to 0 adds four minutes of cold start to the first run of
the day, which is fine.
