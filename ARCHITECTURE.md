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
| `tama.ts`, `setup.ts` | command entry point and interactive first-run setup |
| `import.ts` | read-only walk of an external Markdown folder; all destination writes still go through `Vault` |
| `whisper.ts` | bringing whisper.cpp up locally: model download, per-user service |
| `ui.ts` | terminal colour, dropped whenever stdout is not a colour-capable tty |
| `auth.ts` | device tokens (hashed at rest), single-use pairing codes |
| `grants.ts` | what a token may do (`capture`, `read`, `write`, `ask`) and where, kept separate from the audience it speaks as |
| `views.ts` | named subsets of the vault, applied during the walk rather than after scoring |
| `idempotency.ts` | claim, replay, release. A retry must not write a second note |
| `audio.ts` | ffmpeg to 16 kHz mono, spawned with an argv array reading stdin |
| `stt.ts` | whisper.cpp client (model stays resident) and the hosted `/audio/transcriptions` shape |
| `capture-time.ts` | when the user actually spoke, from client headers within sanity bounds |
| `vault.ts` | **every** read and write, and all seven invariants below |
| `retrieval.ts` | grep over the vault, ranked, behind a `Retriever` interface |
| `pin.ts` | notes chosen by path rather than found by score, bounded and view-checked |
| `llm.ts` | two adapters behind one streaming interface |
| `ask.ts` | retrieve, frame as data, stream |
| `digest.ts` | counts and failures, daily. Needs no model, a digest is arithmetic |
| `notify.ts` | console or ntfy |
| `whatsapp.ts` | signed Cloud API webhook, allowed senders, durable inbox and Meta media/messages client |

## Setup is an explicit, local-first choice

`tama-server setup` creates a new empty git-backed vault only after confirmation and writes a
private config outside the repository. It starts with local whisper.cpp and lets the owner
leave `/ask` disabled, select a local Ollama-compatible server, or opt into OpenRouter.
Provider and WhatsApp credentials are referenced through separate private key files or environment
variables rather than embedded in the generated config. The optional WhatsApp step creates the
webhook verification secret locally and prints the callback details the admin must explicitly put
into Meta. Setup preserves the admin token and unrelated settings when reconfigured. A setup wizard
must never silently route audio or vault excerpts to a cloud service. Its explicit import choice may
add new Markdown files to a non-empty vault through `Vault`, but may never overwrite an existing note.

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

The local setup wizard and admin-only import command are not capture and may preserve an existing
note's relative path so its wiki-links survive. They still go through `Vault`: imports are
new-file-only, identical replays are skipped, different collisions are refused, writes are atomic
and every imported note is journalled. The source folder is external read-only input and is never
modified.

These are cheap now and impossible to retrofit after the first data loss.

## The vault is a plain git-tracked folder

Deliberately not a cloud-sync folder. iCloud, Dropbox and OneDrive serve placeholder stubs
for files that have not materialised, race the writer, and produce conflict copies. git is
the sync and backup story instead.

On a remote deployment the vault lives on that host, and git is how it reaches your laptop:
the server is the origin, you clone it, Obsidian opens the clone.

## WhatsApp is an optional transport

The WhatsApp Cloud API adapter terminates Meta's webhook authentication and then calls the same
capture and ask operations as a paired device. Voice notes enter capture; text messages enter
ask. The choice is made before either operation starts, so capture does not acquire a dependency
on `ask.ts` or on a language model.

Webhook delivery is not held open while ffmpeg, Whisper, retrieval or an LLM runs. Once a signed
event is from the configured phone-number ID and an explicitly allowed sender, its small envelope
is committed to the operational SQLite database and Meta is acknowledged. A worker downloads
audio with the Cloud API, processes the message, and replies in the same chat. Meta message IDs
deduplicate webhook retries and become capture idempotency keys. Pending work survives restarts;
completed rows retain only the opaque message ID, discarding the sender, question and answer.

Text messages carry conversation memory, so a follow-up in a chat means something. The thread is
the same keyed pseudonym capture attributes a note to, not the phone number: `conversation_turns`
outlives the inbox row the sender is blanked from, so a raw number there would undo that
discarding in a table nothing wipes. It is also disjoint from a paired device's history by
construction, because `/ask` namespaces those as `<audience>:<thread>`.

This is not part of the local/accountless default. With no `whatsapp` block, no webhook is exposed
and capture remains useful without Meta, a public hostname, or any additional credential.

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

## Some notes are chosen, not matched

Retrieval is scoring, and scoring can only return what a question's words touch. That leaves a
whole class of question unanswerable: not "what did I decide about the mic gain", which is a
word-overlap problem, but "which of these two notes is the real one", which is a question about
how the vault is arranged rather than about what any note says.

A file describing that arrangement is unfindable by grep, and not for want of tuning. It shares
almost no vocabulary with any question asked of it, coverage is the heaviest ranking signal, and
scoring it would spend one of `ask.maxChunks` slots. It would also drop out of results exactly
as the vault filled with contradictions, which is when it is needed.

So `ask.pin` names notes by path and `pin.ts` reads them on every question, in two roles:
`conventions` for durable structure and `state` for what is live now. The conventions role is
the only thing that overrides "prefer the newer note", which is what stops a regenerated daily
file being read as authority on the present.

Three properties make this safe rather than a hole:

1. **A pin is data.** It is fenced in the user message like an excerpt, never given system
   authority. Pinning a file into every request makes it the most valuable file in the vault to
   an attacker, so the version that reads it into the system prompt is the version that hands
   that attacker every question. A pin establishes facts about how the vault is arranged; it
   cannot reach the ground rules.
2. **A pin obeys the view.** Each path is checked with `visible()` before it is read, so a
   scoped audience is never handed a guide naming files its view hides. A filename alone
   discloses, which is why `NO_CITE_RULES` exists.
3. **A pin is bounded and loud.** 8 notes, 32KB each, 64KB total, read through `Vault.readNote`
   so containment stays in the adapter that owns it. Anything skipped, missing or cut is logged
   once per process, because a pin that silently does nothing is worse than no pin: the owner
   reasons about every answer as though the file were being read.

Not cached. The only cache breakpoint is the Anthropic adapter's `system` parameter, and
property 1 forbids putting a pin there, so the volatility split between the two roles buys
framing rather than a discount.
