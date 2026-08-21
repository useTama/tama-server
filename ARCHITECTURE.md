# Architecture

What is actually built. Planned work lives in
[issues](https://github.com/useTama/tama-server/issues).

<a href="https://raw.githubusercontent.com/useTama/tama-server/main/assets/architecture-light.svg">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/useTama/tama-server/main/assets/architecture-dark.svg">
    <img src="https://raw.githubusercontent.com/useTama/tama-server/main/assets/architecture-light.svg" width="820"
         alt="Clients post to tama-server, which runs two paths. Capture is ffmpeg then whisper.cpp then an atomic journalled write, and it writes to your vault. Ask is grep retrieval then an LLM adapter, and it reads from your vault.">
  </picture>
</a>

Two paths through one process, one folder in the middle. Capture writes to the vault, ask
reads from it. They share auth, the config and the vault adapter, and nothing else.

## Capture is a strict prefix of ask

Capture never touches a language model. That is not a limitation to be lifted later, it is
what lets the quickstart be "install, point at a folder, talk, see a file appear" with no
account and no key. Ask is the opt-in upgrade, and by the time anyone is asked for a
credential they have already watched the thing work.

Nothing in `ask.ts` may be reachable from the capture path.

## The modules

| Module | Owns |
|---|---|
| `index.ts` | routes, the bearer check, the inflight limit |
| `auth.ts` | device tokens (hashed at rest), single-use pairing codes |
| `idempotency.ts` | claim, replay, release. A retry must not write a second note |
| `audio.ts` | ffmpeg to 16 kHz mono, spawned with an argv array reading stdin |
| `stt.ts` | whisper.cpp client, model stays resident between requests |
| `capture-time.ts` | when the user actually spoke, from client headers within sanity bounds |
| `vault.ts` | **every** read and write, and all seven invariants below |
| `retrieval.ts` | grep over the vault, ranked, behind a `Retriever` interface |
| `llm.ts` | two adapters behind one streaming interface |
| `ask.ts` | retrieve, frame as data, stream |
| `digest.ts` | counts and failures, daily. Needs no model, a digest is arithmetic |
| `notify.ts` | console or ntfy |

## Only the vault adapter touches files

Every invariant lives in `vault.ts` rather than scattered across callers, which is what makes
them enforceable in one place and checkable in one test file.

1. Captures are append-only into new dated files. Existing notes are never edited.
2. Filenames come from the clock, never from the transcript.
3. Refuse to start against an unprotected vault.
4. Every write is journalled to `.tama/write-journal.jsonl`.
5. Writes are confined to the vault root, checked lexically **before** any `mkdir`, then
   again after resolving symlinks.
6. Writes are atomic: temp file, fsync, rename. No reader sees a partial note.
7. `safety.dryRun` prints intended writes and touches nothing.

These are cheap now and impossible to retrofit after the first data loss.

## The vault is a plain git-tracked folder

Deliberately not a cloud-sync folder. iCloud, Dropbox and OneDrive serve placeholder stubs
for files that have not materialised, race the writer, and produce conflict copies. git is
the sync and backup story instead.

On a remote deployment the vault lives on that host, and git is how it reaches your laptop:
the server is the origin, you clone it, Obsidian opens the clone.

## Untrusted input, twice

**A transcript** never becomes a path and never reaches a shell.

**A retrieved note** is framed as data, never as instruction. A vault can be synced from
elsewhere or filled by anyone who can reach `/capture`, and a note is free text that may
contain something shaped like a command. Excerpts are fenced with explicit begin/end markers
inside a user message, never given system authority, and the system prompt states plainly
that they are data.

This matters more the moment a model gains append tools over the same vault.

## Two LLM adapters, not one

Anthropic's Messages API is not OpenAI-shaped: the system prompt is a top-level parameter
there, and a message with `role: "system"` everywhere else. So it cannot ride the shared
client. One OpenAI-compatible adapter covers Ollama, llama.cpp, LM Studio, vLLM, OpenAI,
Groq, OpenRouter, Together and Gemini's compatibility endpoint.

## Retrieval is grep

It walks the vault, scores notes by how many distinct query terms they match with a nudge for
filename hits and recency, and returns excerpts. There is no index to build, corrupt or
rebuild, and no staleness problem when a new note lands.

It genuinely works at a few hundred notes, and it sits behind a `Retriever` interface so
moving to FTS5 or vectors later is a one-file change. Worth doing when a real question comes
back wrong, not before.
