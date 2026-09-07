---
source: text
captured: 2025-01-05T20:00:00+05:30
---
# Decisions

**Retrieval stays grep.** No embeddings, no FTS5, no sidecar index, until a
real question comes back wrong. An index is a derived copy that has to be kept
correct, and at a few hundred notes it buys nothing measurable.

**The vault is a folder, not a database.** Markdown on a filesystem that other
tools can read. Git is for history, and git is not GitHub.
