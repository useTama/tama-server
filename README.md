# tama-server

Talk into a small device, and a markdown note appears in a folder you own.

Self-hosted, open source, and **zero recurring cost**. Speech-to-text runs locally.
There is no language model in the capture path, so there is no API bill, no account,
and no key — not as a free tier, but as the whole design.

    device ──POST──▶ tama-server ──▶ whisper.cpp (local) ──▶ your-vault/Inbox/2026-08-19-0912-voice.md
                          │
                          └──▶ ntfy ──▶ your phone   (failures + a daily digest)

## Requirements

    brew install bun ffmpeg whisper-cpp      # or the apt/docker equivalents

One model, once:

    mkdir -p ~/.local/share/whisper
    curl -L -o ~/.local/share/whisper/ggml-small.bin \
      https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin

Use `ggml-base.bin` on a Raspberry Pi. `large-v3` needs a real GPU.

## The vault

A plain local directory, git-tracked. **Not** a cloud-sync folder: iCloud, Dropbox and
OneDrive serve placeholder stubs for files that have not materialised, race the writer,
and produce conflict copies.

    mkdir -p ~/tama-vault/Inbox && git -C ~/tama-vault init

The server refuses to start against a vault that is neither git-tracked nor has a
configured backup. That is deliberate; the override is explicit.

## Run

    cp tama.config.example.json tama.config.json
    # set vault.path, and: openssl rand -hex 24  -> server.adminToken

    whisper-server -m ~/.local/share/whisper/ggml-small.bin --host 127.0.0.1 --port 8081
    bun run dev

## Pair a device

    ADMIN=$(jq -r .server.adminToken tama.config.json)

    curl -X POST localhost:8080/pair/code -H "Authorization: Bearer $ADMIN"
    # -> { "code": "807390" }

    curl -X POST localhost:8080/pair -H 'content-type: application/json' \
      -d '{"code":"807390","deviceName":"cheeko-01"}'
    # -> { "token": "..." }   store it, it is not shown again

Codes are single-use and expire in 10 minutes. Each device gets its own token, so
losing a device revokes one token rather than the whole install.

For a board you are about to flash, mint a token directly instead:

    curl -X POST localhost:8080/tokens -H "Authorization: Bearer $ADMIN" \
      -H 'content-type: application/json' -d '{"deviceName":"cheeko-01"}'

## API

| Route | Auth | Does |
|---|---|---|
| `GET /health` | none | version, min client version, whisper status |
| `POST /pair` | the code itself | redeem a pairing code for a device token |
| `POST /capture` | device token | audio or text in, note path out |
| `POST /pair/code` | admin | mint a pairing code |
| `GET/POST /tokens`, `DELETE /tokens/:id` | admin | list, mint, revoke |
| `GET /digest` | admin | today's digest without waiting for the scheduled one |

### POST /capture

Body is audio in any format ffmpeg can read, or JSON `{"text": "..."}`.

| Header | Why |
|---|---|
| `Idempotency-Key` | **Send this.** A retry after a lost response must not create a second note. A device with a flash queue retries as normal behaviour, not as an edge case |
| `X-Tama-Captured-Age-Ms` | milliseconds since the recording. For devices with **no RTC** — an ESP32 knows how long ago something happened but not what time it is |
| `X-Tama-Captured-At` | absolute ISO-8601, for clients with a real clock |

Without either time header the server uses its own clock, which is only correct for
something posting in real time.

### Client retry policy

| Status | Client does |
|---|---|
| `2xx` | dequeue |
| `401` | stop, re-pair. never retry |
| `413` `422` | drop, tell the user |
| `429` `503` `5xx` timeout | retry with backoff, **same idempotency key** |

## Notifications

`console` by default. Set `notify.provider` to `ntfy` for push to your phone.

ntfy rather than APNs or FCM on purpose: those need a developer account and per-app
credentials, which is cost and paperwork pushed onto every self-hoster. ntfy is an HTTP
POST to a topic, works on iOS and Android, and can itself be self-hosted.

You get told when: a capture fails, **nothing was heard** (mic muted or too quiet),
whisper is down, or a new device pairs. Plus a daily digest of counts and failures —
which needs no language model, because a digest is arithmetic.

## Vault invariants

Not features. Cheap now, impossible to retrofit after the first data loss.

1. Captures are append-only into new dated files. Existing notes are never edited.
2. Filenames come from the clock, never from the transcript.
3. Refuse to start against an unprotected vault.
4. Every write is journalled to `.tama/write-journal.jsonl`.
5. Writes are confined to the vault root — checked lexically **before** any `mkdir`,
   then again after resolving symlinks.
6. Writes are atomic: temp file, fsync, rename. No reader sees a partial note.
7. `safety.dryRun` prints intended writes and touches nothing.

A transcript is untrusted input. It never becomes a path and never reaches a shell;
ffmpeg is spawned with an argv array reading stdin.

## Test

    bun test        # 29 tests
    bun run typecheck

## Not here yet

Asking questions of your notes, retrieval, any language model, a websocket, the phone
app. Each is a later step and none of them changes what is above.

Firmware lives in `tama-firmware`.

## Licence

Apache-2.0
