# WhatsApp bridge (unofficial)

Send a voice note to WhatsApp, get a note in your vault. Ask a question, get an
answer from your own notes.

This logs into WhatsApp Web as **your own account**, the same way the desktop
app does. That is the whole appeal and the whole problem.

|  | This bridge | The `whatsapp` config block |
|---|---|---|
| Meta business app | not needed | required |
| Dedicated phone number | not needed — your own | required, and it stops being a normal WhatsApp |
| Public HTTPS + domain | **not needed**, the socket is outbound | required, Meta posts to you |
| WhatsApp's terms | **violates them; the account can be banned** | supported |
| Breakage | whenever WhatsApp Web changes | versioned API |

Use the config block if you can. Use this if you want your second brain on
WhatsApp today without buying a domain and registering a business number.

It is a **client**, like `clients/ios-shortcut`. It holds a device token and
posts to the public `/capture` and `/ask` routes. `tama-server` is unmodified
and does not know it exists — no `whatsapp` block, no webhook, no app secret.

## How it behaves

| You send | It does |
|---|---|
| Voice note | transcribes and saves a note, replies with the path |
| Voice note in your own self-chat | same |
| `?what did I say about the mic gain` in self-chat | asks your notes, replies with the answer |
| Plain text in self-chat | **ignored** — self-chat is also a scratchpad |
| Any text from an allowed contact | asks your notes |
| Anything in a group | ignored |
| Anything from a number not on the allowlist | ignored |

Voice note captures, text asks. That mirrors the Cloud API adapter. Self-chat
is the exception: plain text there is left alone so pasting yourself a link
does not spend a model call, and the `?` prefix asks instead.

## Setup

**1. Mint a device token.** Not the admin token — a device token, from pairing:

```sh
cd ~/tama
ADMIN=$(sudo grep -o '"adminToken": *"[^"]*"' config/tama.config.json | cut -d'"' -f4)
CODE=$(curl -s -X POST localhost:8080/pair/code -H "Authorization: Bearer $ADMIN" | jq -r .code)
curl -s -X POST localhost:8080/pair -H 'content-type: application/json' \
  -d "{\"code\":\"$CODE\",\"deviceName\":\"whatsapp-bridge\"}" | jq -r .token
```

**2. Put it in `.env`** alongside `docker-compose.yml`:

```sh
echo 'TAMA_TOKEN=paste_the_device_token' >> .env
```

Optionally allow other people to ask and send notes — your own number is
already allowed through self-chat and does not need listing:

```sh
echo 'WA_ALLOWED=919876543210,918887776665' >> .env
```

**3. Start it and scan the QR:**

```sh
docker compose --profile whatsapp-webjs up -d --build
docker compose --profile whatsapp-webjs logs -f whatsapp-webjs
```

A QR code prints in the logs. On your phone: **WhatsApp → Settings → Linked
devices → Link a device**. Scan it. The log then says `ready as <your number>`.

The session is saved to the `whatsapp-session` volume, so a rebuild or restart
does not ask again.

**4. Test it.** Message yourself a voice note. Within a few seconds the reply
is `Saved to your second brain.` and a path. Then send `?what did I just say`.

Keep `--profile whatsapp-webjs` on every later `docker compose` command, or
Compose treats this container as an orphan and stops it.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `TAMA_TOKEN` | — | device token, required |
| `TAMA_URL` | `http://tama:8080` | the server, over the Compose network |
| `WA_ALLOWED` | empty | comma-separated senders, country code + digits |
| `WA_ASK_PREFIX` | `?` | what marks a self-chat message as a question |
| `WA_WEB_VERSION_HTML` | unset | pin the WhatsApp Web page (see below) |

## When it breaks

**Stuck before the QR, or a blank QR.** WhatsApp Web shipped a change
whatsapp-web.js has not caught up with. Pin a known-good page:

```sh
echo 'WA_WEB_VERSION_HTML=https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1023204200.html' >> .env
docker compose --profile whatsapp-webjs up -d
```

Then bump the library: `docker compose --profile whatsapp-webjs build --no-cache whatsapp-webjs`.

**`auth failed` or a QR after it had been working.** The session expired or was
unlinked from the phone. Wipe it and scan again:

```sh
docker compose --profile whatsapp-webjs down
docker volume rm tama_whatsapp-session
docker compose --profile whatsapp-webjs up -d --build
```

**Voice notes save but questions do not answer.** `/ask` needs an `ask` block
in `tama.config.json`. The bridge replies saying so.

**Nothing happens at all.** `docker compose --profile whatsapp-webjs logs
whatsapp-webjs`. A `skip sender not allowed` line means `WA_ALLOWED` does not
contain that number in country-code-plus-digits form.

**Chromium dies immediately.** Out of memory. The browser wants ~500 MB on top
of tama; a 1 GB box cannot run both this and local whisper.

## What it does not do

- No group capture, deliberately.
- No image, document or location handling. Voice and text only.
- No queue. The Cloud API adapter persists inbound messages in SQLite and
  retries with backoff; here a message that fails after three attempts is a
  reply saying so, and it is gone. The capture idempotency key still stops a
  WhatsApp redelivery from writing the same note twice.
