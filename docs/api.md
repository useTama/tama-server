# API reference

All routes are on `localhost:8080` by default. `GET /health` is open, `POST /pair`
authenticates with the pairing code itself, and the optional WhatsApp webhook uses Meta's
verification-token/HMAC protocol. Everything else needs a bearer token.

| Route | Auth | Does |
|---|---|---|
| `GET /health` | none | version, min client version, whisper status |
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

Without either time header the server uses its own clock, which is only correct for something
posting in real time.

### Client retry policy

| Status | Client does |
|---|---|
| `2xx` | dequeue |
| `401` | stop, re-pair. never retry |
| `413` `422` | drop, tell the user |
| `429` `503` `5xx` timeout | retry with backoff, **same idempotency key** |

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

## Notifications

`console` by default. Set `notify.provider` to `ntfy` for push to your phone.

ntfy rather than APNs or FCM on purpose: those need a developer account and per-app
credentials, which is cost and paperwork pushed onto every self-hoster. ntfy is an HTTP POST
to a topic, works on iOS and Android, and can itself be self-hosted.

You get told when a capture fails, when **nothing was heard** (mic muted or too quiet), when
whisper is down, and when a new device pairs. Plus a daily digest of counts and failures.

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
