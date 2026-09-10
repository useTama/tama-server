# API reference

All routes are on `localhost:8080` by default. `GET /health` is open, `POST /pair`
authenticates with the pairing code itself, and the optional WhatsApp webhook uses Meta's
verification-token/HMAC protocol. Everything else needs a bearer token.

`/health` answers everyone with `{ok, version, minClient}` — enough for an uptime check, and
enough for a client to discover it is too old before it has been trusted with anything. The
rest of the body, which describes how this box is configured, needs a token.

Repeatedly presenting a credential that does not work earns a `429` with a `Retry-After`,
per source address, on every route behind the bearer check. A token that works is never
throttled, and `/health` is deliberately outside it so an uptime check is not collateral
damage from somebody else guessing at the same address.

| Route | Auth | Does |
|---|---|---|
| `GET /health` | none, or a token for more | liveness and the version contract; with a token, how this box is configured |
| `GET /pair` | admin | a page showing a QR code a phone can scan |
| `POST /pair` | the code itself | redeem a pairing code for a device token |
| `POST /capture` | device token | audio or text in, note path out |
| `POST /ask` | device token | ask a question, get an answer from your notes |
| `GET, POST /webhooks/whatsapp` | Meta webhook | optional WhatsApp verification and inbound messages |
| `POST /pair/code` | admin | mint a pairing code |
| `GET /tokens` | admin | list devices |
| `POST /tokens` | admin | mint a token directly |
| `DELETE /tokens/:id` | admin | revoke one device |
| `GET /digest` | admin | today's digest without waiting for the scheduled one |

## Pairing

A device gets a token by redeeming a short-lived code. There are two ways to put that code
in front of a device: a page it can photograph, or a terminal.

### GET /pair

Open it in a browser and it mints a code and draws it as a QR code, one per address the
machine might be reachable at. `tama-server setup` prints the link.

```
http://localhost:8080/pair?token=$ADMIN
```

Admin-only, because whoever can mint a pairing code can pair themselves into the vault. A
browser cannot attach an `Authorization` header to a plain navigation, so this route — and
only this route — also accepts the admin token as `?token=`. Treat that URL as the admin
token itself: it is one. The page is served `no-store`, sends no referrer, refuses to be
framed, and loads nothing from anywhere.

Each load mints a fresh code, so reloading is how you get another one.

The QR encodes JSON rather than a URL, so a camera app that helpfully opens links finds
nothing to open, and a client can parse it with stock tooling:

```json
{ "v": 1, "url": "http://192.168.1.20:8080", "code": "807390" }
```

`url` is an address the *device* has to reach, which is rarely the one the admin is browsing.
The page offers the machine's LAN addresses first and `localhost` last for that reason.

[`clients/ios-shortcut`](../clients/ios-shortcut) is a client built around this: scan, and
the phone is paired.

### From a terminal

```sh
ADMIN=$(jq -r .server.adminToken tama.config.json)

curl -X POST localhost:8080/pair/code -H "Authorization: Bearer $ADMIN"
# -> { "code": "807390" }

curl -X POST localhost:8080/pair -H 'content-type: application/json' \
  -d '{"code":"807390","deviceName":"cheeko-01"}'
# -> { "token": "..." }   store it, it is not shown again
```

Codes are single-use and expire in 10 minutes, however they were shown. Failed redemption
attempts are limited per caller during that window to make a six-digit code impractical to
brute-force. Each device gets its own token, so losing a device revokes one token rather
than the whole install.

For a board you are about to flash, mint a token directly instead:

```sh
curl -X POST localhost:8080/tokens -H "Authorization: Bearer $ADMIN" \
  -H 'content-type: application/json' -d '{"deviceName":"cheeko-01"}'
```

## WhatsApp Cloud API

This optional adapter lets an allowed user message a dedicated WhatsApp Business Platform number:

- a voice note is downloaded from Meta, transcribed through the configured STT provider, and
  appended as a capture;
- a text message is treated as a question for `/ask` and the answer is sent back into the chat;
- if Ask is not configured, text gets an unavailable explanation while voice capture keeps working.

It uses [Meta's official Cloud API](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api),
not browser automation or an unofficial WhatsApp Web library. Create a Meta business app, add the
WhatsApp product, connect a WhatsApp Business Account and register the dedicated number. The
temporary user token from the API Setup screen is enough for a test; for a running server, create
a system-user token with `whatsapp_business_messaging` (and `whatsapp_business_management` when
your Meta asset setup requires it). A number kept for Tama is the simplest setup; do not migrate a
number carrying personal chat history merely to test the integration.

The callback must therefore be reachable from Meta at a public HTTPS address. Put a reverse proxy
or tunnel in front of Tama and expose only:

```
https://your-host.example/webhooks/whatsapp
```

In the Meta app's WhatsApp/Webhooks configuration, use that callback URL, subscribe the WhatsApp
Business Account to `messages`, and enter the same random verify token that Tama loads. Meta's GET
challenge is compared with that token. Every POST must also carry Meta's `X-Hub-Signature-256`;
Tama verifies the HMAC over the exact request body with the Meta app secret before parsing it.

The interactive path is `tama-server setup` (or `bun run setup` from source), then choose
**Connect a WhatsApp Cloud API number**. It hides all three credentials, writes them to separate
owner-readable files, checks the number/token against Meta, and prints the exact callback URL and
verify token for the Meta dashboard.

For a scripted deployment, add this block to `tama.config.json` (the environment variable names
are examples):

```json
{
  "whatsapp": {
    "phoneNumberId": "123456789012345",
    "allowedFrom": ["919876543210"],
    "publicBaseUrl": "https://tama.example.com",
    "accessTokenEnv": "WHATSAPP_ACCESS_TOKEN",
    "appSecretEnv": "WHATSAPP_APP_SECRET",
    "verifyTokenEnv": "WHATSAPP_VERIFY_TOKEN",
    "graphApiVersion": "v23.0"
  }
}
```

`phoneNumberId` is Meta's ID for the Tama number, not its visible phone number. `allowedFrom` is
the vault access control list: each entry is an international sender number with country code,
digits only and no `+`. Messages for a different Cloud API number, messages from anyone outside
that list, delivery receipts, and unsupported message types are acknowledged but ignored.

Generate the webhook verify token yourself (`openssl rand -hex 32` is suitable). The access token,
Meta app secret and verify token also support `...File` keys with paths relative to the config file
(for example, `accessTokenFile`). Do not put any of them in source control. Restart Tama after
setting them in the service environment. `GET /health` then reports `whatsapp.available: true`.

Signed events are durably queued before the webhook responds, because local transcription can take
longer than Meta should be kept waiting. The Meta message ID deduplicates webhook retries and voice
captures. Failed media downloads, inference calls and outgoing sends retry with backoff. Once a
reply succeeds, Tama removes the phone number, message content and generated answer from the queue
row, retaining only the message ID needed for deduplication.

## POST /capture

Body is audio in any format ffmpeg can read, or JSON `{"text": "..."}`.

| Header | Why |
|---|---|
| `Idempotency-Key` | **Send this.** A retry after a lost response must not create a second note. A device with a flash queue retries as normal behaviour, not as an edge case |
| `X-Tama-Captured-Age-Ms` | milliseconds since the recording, for devices with **no RTC**. An ESP32 knows how long ago something happened but not what time it is |
| `X-Tama-Captured-At` | absolute ISO-8601, for clients with a real clock |
| `X-Tama-Client` | `name/0.2.1`, or a bare `0.2.1`. Compared against the `minClient` on `/health`; a client that says it is older is refused with `426`. **Absent is accepted** - silence is not a claim, and every client predates this header - so sending it is what makes a client eligible to be told it is too old |

Without either time header the server uses its own clock, which is only correct for something
posting in real time.

### Client retry policy

| Status | Client does |
|---|---|
| `2xx` | dequeue |
| `401` | stop, re-pair. never retry |
| `413` `415` `422` `426` | drop, tell the user |
| `502` | drop, tell the user. An upstream answered and refused, so asking again spends the same rejection |
| `429` `503` other `5xx`, timeout | retry with backoff, **same idempotency key** |

A failed capture answers `{"error": "<what broke>. <what to do>"}`, and adds `"stage"` —
`audio`, `stt` or `vault` — when it knows which part failed. **Show the `error` to the user.**
It is the whole diagnostic on this path: capture needs no account and no key, so whoever hit
the failure has no vendor to ask, and they are usually the person who can fix it.

| Status | Means |
|---|---|
| `415` | ffmpeg ran and could not decode the upload. Truncated, empty, or a format this build has no decoder for |
| `422` | decoded fine, but no speech came out. `reason: "no-speech-detected"` |
| `502` | the speech-to-text provider refused: wrong key, wrong model, rejected file |
| `503` | speech to text is unreachable or timed out. Not started, still loading a model, or a wrong `stt.url` |
| `426` | the client sent `X-Tama-Client` and it is below `minClient`. Update the client; retrying spends the same refusal. The refusal happens before the idempotency key is claimed, so an updated client can deliver the same queued note under the same key |
| `500` | the server's own fault: ffmpeg not installed, or the vault unwritable - a full disk, a read-only mount, a directory the server does not own. Retrying spends the same failure, so this is a drop-and-tell-the-user despite being a 5xx |

## POST /ask

Optional. Capture never touches a language model, so with no `ask` block configured this
answers 501 and everything else keeps working with no account and no key.

```sh
curl -X POST localhost:8080/ask -H "Authorization: Bearer $DEVICE_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"question":"what did I say about the mic gain?"}'

# -> { "ok": true, "answer": "...", "sources": [{"path":"Inbox/...","score":11.8}], "ms": 2400 }
```

Add `"stream": true` for server-sent events instead: one JSON object per `data:` line, typed
`sources` first (before the model has said anything), then `delta`, then `done`.

Emitting sources first is deliberate. A client can show what is being read from while the
model is still thinking, and a caller can tell "found nothing" apart from "the model had
nothing to say".

`sources` is also empty when the message was not a question about the notes at all. "hi",
"thanks", "bruh", or the server's own name is contact rather than enquiry, and the vault is not
searched for it: a greeting used to retrieve whatever the previous question had been about and
read that back. A client cannot tell this apart from a search that matched nothing, and does not
need to. The difference is in what the model is told, not in the response shape.

### The answer is checked before it is returned

Two things are enforced on the finished text rather than asked for in the prompt, because both
were asked for and both were broken:

- a path the model was never shown is removed, and the sentence around it is kept. Every path in
  a returned answer names a note that was actually in the context.
- an answer claiming to have written, filed, saved or set a reminder is replaced. This route is
  read-only, so every such claim is false.

On the buffered response this is exact. With `"stream": true` the guard runs once the answer is
complete, so a client rendering `delta` events shows the unguarded text first and `done` carries
the corrected answer. Render `done` if you can only render one.

### Saying which surface you are

A chat client should send `surface`, because nothing else can tell the server what medium the
answer lands in:

```json
{ "question": "can you see this?", "surface": { "app": "whatsapp", "address": "918088775227" } }
```

`app` must be a surface this server knows (`whatsapp` today) and `address` is this client's own
number on it. With them the model is told which app it is reached on, at what address, that a
voice note becomes a note, and that images and documents do not reach it at all. Without them
it answers questions about its own medium by guessing, and has nothing whatsoever for "what is
your number".

Both are validated, not repeated: an unknown `app` produces no sentence rather than putting a
client's string into the system prompt, and a non-numeric `address` is dropped while the app is
kept. Omit the block entirely from a terminal or a script - there is no surface to describe, and
inventing one would be a confident lie about the situation rather than a missing fact.

### Providers

The setup wizard can connect to an existing chat server, discover its models, and test a
selected model. Keys entered in setup are stored in owner-readable files referenced by
`apiKeyFile`; manual configurations can use `apiKeyEnv`. Credentials are sent as Bearer
authentication on both paths.

| `stt.provider` | Talks to | Needs |
| --- | --- | --- |
| `whisper-cpp` | whisper.cpp's `whisper-server`, local or remote | `url` |
| `openai-compatible` | `POST {url}/audio/transcriptions` — Groq, OpenAI | `url`, `model` |
| `sarvam` | `POST {url}/speech-to-text` — Sarvam AI | key; `url`, `model`, `language` default |

Sarvam is a separate adapter rather than a variant of the OpenAI shape, because all three
things that matter differ: the route, the auth header (`api-subscription-key`, not `Bearer`)
and the response field (`transcript`, not `text`). It earns the extra code on Indian languages
and code-mixed Hindi-English speech, where whisper is noticeably worse.

```json
"stt": { "provider": "sarvam", "model": "saaras:v3", "language": "hi-IN", "apiKeyEnv": "SARVAM_API_KEY" }
```

`url` defaults to `https://api.sarvam.ai` and `model` to `saaras:v3`. `language` is a BCP-47
hint — `hi-IN`, `en-IN`, `ta-IN` — or `unknown` to auto-detect, which is the default. Setup's
reachability check cannot verify a Sarvam key, because Sarvam serves no listing route; a bad
key first shows up on the first capture.

Formats outside these three are not supported.

| `ask.provider` | Covers | Needs |
|---|---|---|
| `openai-compatible` | Ollama, llama.cpp, LM Studio, vLLM, OpenAI, Groq, OpenRouter, Together, Gemini | `baseUrl` + `model`. Local servers need no key |
| `anthropic` | Claude models | `model`, plus `apiKey` or `$ANTHROPIC_API_KEY` |

### Pinning notes into every answer

Retrieval can only return what a question's words match, which leaves the model nothing to
answer "which of these two notes is the real one" with. `ask.pin` names notes by path instead:

```json
"ask": { "pin": { "conventions": ["CLAUDE.md"], "state": ["Now.md"] } }
```

`conventions` is durable structure: which note is the source of truth for a subject, which files
are generated and disposable, what the folders mean. It is the only thing that overrides "prefer
the newer note", so a file you regenerate every morning stops being read as authority on the
present. `state` is what is live now, and is preferred over older notes for anything about the
present.

Both are read as untrusted note text, fenced exactly like a retrieved excerpt, and neither can
change the model's instructions. Each path is checked against the requesting token's view, so an
audience is never shown a pin its view excludes. That check is on the path and not the contents:
a conventions file a scoped view does admit will still name whatever folders it names, so do not
pin one to a scoped audience unless you are content for it to see the shape of the vault.
Bounded at 8 notes, 64KB each and 128KB in total, read on every question; anything missing,
hidden, oversized or skipped is logged once per process, along with the total pinned size and
roughly what it costs in tokens per question, because that is the one thing about pinning an
owner cannot otherwise see. Omit the block to pin nothing, which is
how this behaved before pinning existed.

A greeting is not given the pins either, since answering "hi" with the whole of a "what is live
now" file is a status report nobody asked for.

## Notifications

`console` by default. Set `notify.provider` to `ntfy` for push to your phone.

ntfy rather than APNs or FCM on purpose: those need a developer account and per-app
credentials, which is cost and paperwork pushed onto every self-hoster. ntfy is an HTTP POST
to a topic, works on iOS and Android, and can itself be self-hosted.

You get told when a capture fails, when **nothing was heard** (mic muted or too quiet), when
whisper is down, and when a new device pairs. Plus a daily digest of counts and failures.

## POST /feedback

Say an answer was wrong. **Owner's device only** — a `403` for any audience.

```sh
curl -X POST localhost:8080/feedback -H "Authorization: Bearer $DEVICE_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"thread":"chat-1","verdict":"wrong","note":"answered about a github issue"}'

# -> { "ok": true, "recorded": "wrong", "question": "what can be the issue",
#      "retrieved": [{"path":"Projects/hermes/incident-2025-01-30.md","score":8.4}] }
```

| Field | |
|---|---|
| `thread` | required. The same opaque id `/ask` was given, so a verdict lands on the right conversation |
| `verdict` | required. `"wrong"` or `"right"` |
| `askId` | optional. Names one answer instead of the most recent in that thread |
| `note` | optional, 500 chars. What was actually wrong |

`404` when the thread has no recent answer to rate. Only the last 10 per thread are kept, so
a verdict has to arrive within a few messages.

Appends one JSON object per line to `<dataDir>/feedback.jsonl`, recording the question and
**what retrieval returned** — which is where most bad answers turn out to come from. The
answer text is not kept: the question and the paths are enough to reproduce and triage, and
storing answers would grow a second copy of the vault's content somewhere with none of the
vault's rules.

Nothing is sent anywhere. There is no collection endpoint. The file is a notebook for a person
to read when deciding what belongs in the golden set, and promotion stays a human judgement.

Owner-only for a reason: in a group the question is often somebody else's message, and this
record is permanent where conversation history is not, so an open route would let a stranger
both fill the file with other people's words and decide what the eval set gets built from.

## POST /notes

Append text to a note at a path you choose, or create one. This is the write
path for something that already has text and knows where it belongs: an agent
finishing work on a repo, a script, a cron job. `/capture` is for a voice note,
where the server decides the filename.

```sh
curl -s -X POST localhost:8080/notes \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H "Idempotency-Key: $(openssl rand -hex 8)" \
  -d '{"path":"Projects/tama/log.md","text":"## fixed the mention detection\n"}'
```

| Field | |
|---|---|
| `path` | vault-relative, must end `.md`, no `..`, no dotfiles, no symlink escape |
| `text` | Markdown. 25 MB cap, same as capture |
| `mode` | `append` (default) or `create`. `create` refuses to touch an existing file |

Append uses `O_APPEND`, so two writers finishing at once interleave whole
entries rather than overwriting each other, and a retry cannot lose the other
one's work. `Idempotency-Key` still collapses a repeat of the *same* request.

**Owner devices only.** A token with an audience gets a 403: an audience reads,
and a group's token holding a write path would be the first way a room could put
something in someone's notes.

## POST /sessions

Sugar over `/notes` for the case that has a shape: one entry per work session,
appended to `Projects/<slug>/sessions.md`.

```sh
curl -s -X POST localhost:8080/sessions \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"project":"tama","summary":"fixed the @lid chat matching",
       "shipped":["PR #37"],"learned":["a gateway prices a request by max_tokens"],
       "next":["scoped tokens"]}'
```

The project name is slugged, so `tama-server` and `Tama Server` land in the same
file. The first entry writes frontmatter carrying `project`, which is what lets
retrieval tell a session log from a note that merely mentions the project.

From a terminal, `tama session tama < summary.md` does the same thing without a
token, by writing through the vault directly. Over SSH, which is how a laptop
reaches a server whose port is loopback-only:

```sh
echo "fixed the mention detection" | ssh ubuntu@YOUR_SERVER 'cd tama && tama session tama'
```

## POST /mcp

The same capabilities as the routes above, spoken as Model Context Protocol, so
Claude Code and Claude Desktop can use the vault as tools. Same bearer token,
same audience scoping. See [mcp.md](mcp.md).
