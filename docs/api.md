# API reference

All routes are on `localhost:8080` by default. `GET /health` is open and `POST /pair`
authenticates with the pairing code itself; everything else needs a bearer token.

| Route | Auth | Does |
|---|---|---|
| `GET /health` | none | version, min client version, whisper status |
| `GET /pair` | admin | a page showing a QR code a phone can scan |
| `POST /pair` | the code itself | redeem a pairing code for a device token |
| `POST /capture` | device token | audio or text in, note path out |
| `POST /ask` | device token | ask a question, get an answer from your notes |
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

Formats outside those two, Sarvam's among them, are not supported.

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
