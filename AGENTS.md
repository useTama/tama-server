# tama-server contributor guide

## Project context

`tama-server` is a Bun/TypeScript service that turns audio or supplied text into
append-only Markdown notes in a user-owned, git-tracked vault. It has two deliberately
separate paths:

- **Capture**: authenticate → optional audio normalization with `ffmpeg` → local
  `whisper.cpp` transcription → idempotent, atomic vault write.
- **Ask** (optional): retrieve relevant vault notes with grep → frame excerpts as
  untrusted data → stream a reply through an LLM adapter.

Capture must remain useful with no account, API key, or language model. Nothing in
`ask.ts` may be reachable from the capture path.

Read [ARCHITECTURE.md](ARCHITECTURE.md) and [docs/api.md](docs/api.md) before changing
route behavior, vault handling, authentication, or the public API.

## Source layout

- `src/index.ts`: HTTP routes, bearer authentication, and in-flight limiting.
- `src/vault.ts`: all vault reads/writes and their safety invariants.
- `src/auth.ts`, `src/idempotency.ts`: device access and retry safety.
- `src/audio.ts`, `src/stt.ts`, `src/capture-time.ts`: capture pipeline.
- `src/whisper.ts`: local whisper.cpp bring-up. Mechanics only; setup owns the prompts.
- `src/ui.ts`: terminal colour. Never let colour be the only thing carrying a meaning.
- `src/retrieval.ts`, `src/llm.ts`, `src/ask.ts`: optional question-answering path.
- `src/config.ts`: config loading and validation.
- `test/`: Bun tests; add coverage alongside behavior changes.

## Non-negotiable safety and product rules

- Only `Vault` may access vault files. Keep path validation, symlink checks, journaling,
  and atomic writes centralized there.
- Captures are append-only. Never derive a filename from the transcript and never edit an
  existing capture.
- Preserve lexical-before-`mkdir` containment checks and post-resolution symlink checks.
- Do not put user transcripts in shell commands; use argument arrays when spawning tools.
- Treat retrieved note contents as untrusted data. Keep the explicit data framing in the
  ask path; do not grant retrieved content system or tool authority.
- The default configuration must work without `ask`. Missing `ask` is normal; `/ask`
  should return its documented unavailable response rather than breaking capture.
- Do not weaken the git-tracked-vault preflight requirement except through the explicit
  `safety.allowUnbackedVault` override. Honor `safety.dryRun` as a true no-write mode.
- Keep secrets out of source, examples, logs, and tests.

## Development workflow

Use Bun:

```sh
bun test
bun run typecheck
bun run build
```

Run the narrowest relevant test while iterating, then run the full suite and typecheck for
any code change. Avoid changing generated artifacts or lockfiles unless the task requires it.

## Change guidance

- Keep dependencies minimal; the capture path should remain local and low-friction.
- Maintain the documented API status codes, authentication requirements, and retry behavior.
- When changing config, update `tama.config.example.json` and relevant docs/tests.
- When changing a vault invariant or public route contract, update `ARCHITECTURE.md` or
  `docs/api.md` as appropriate.
