---
source: text
captured: 2025-01-13T15:22:00+05:30
---
# Kubeflow training pipeline

The training pipeline fails on step 4 whenever the s3 credentials rotate. The
credentials are pinned in a secret that nothing rotates, so the pipeline works
until someone rotates the upstream key and then every run dies at the same step
with an opaque access denied.

Fix is an IRSA role on the step's service account instead of a long lived key.
