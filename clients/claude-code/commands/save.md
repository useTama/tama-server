---
description: Record what this session did into your Tama notes
---

Record this session in the user's notes, using the `record_session` tool from
the Tama MCP server.

Work out the arguments from the session itself rather than asking:

- `project` — the repository or project this work happened in. Derive it from
  the working directory. Do not ask if you can see it.
- `summary` — a short paragraph on **what was wrong and why it mattered**, not a
  list of files touched. The reader is this same user in six weeks, who will
  remember the problem and not the diff.
- `shipped` — what actually landed. Commits, not intentions.
- `learned` — the non-obvious things. A cause that was not where it looked, a
  constraint discovered the hard way, an assumption that turned out false. This
  is the field worth the most later and the one most often left empty.
- `next` — what the next session should pick up, including anything deliberately
  left undone.

Two rules about what not to write:

- Nothing that is already recoverable from git. The log has the diff; this has
  the reasoning.
- If a session reached nothing worth keeping, say so and record nothing. An
  entry that says "explored some options" is worse than no entry, because it
  costs a read to discover it is empty.

Then tell the user which file it went into, in one line.
