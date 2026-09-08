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
| Text in your own self-chat | asks your notes |
| Any text from an allowed contact | asks your notes |
| Anything in a group | ignored |
| Anything from a number not on the allowlist | ignored |

Voice note captures, text asks. That mirrors the Cloud API adapter. Plain text
in your own chat always asks; there is no prefix or scratchpad mode.

## Setup

One command:

```sh
tama settings
```

Pick **WhatsApp bridge**. (No `tama` command yet? `sudo ln -s "$PWD/docker/tama"
/usr/local/bin/tama` from the repo, or use `docker compose run --rm settings`.)
The first-run wizard, `tama setup`, offers the same thing under **WhatsApp** →
**Link your own WhatsApp number**. It asks:

| Question | What it means |
|---|---|
| Your own other numbers | Your second phone, your work number. They are treated as you and can use the whole vault with your token. Anyone who is not you needs an audience instead. |

It mints the device token itself and writes `config/whatsapp-bridge.json`
(0600). There is no token to copy, and nothing to put in `.env`.

Then start it and scan the QR:

```sh
tama start
tama logs whatsapp-webjs
```

On your phone: **WhatsApp → Settings → Linked devices → Link a device**. The
log then says `ready as <your number>`. The session is saved to the
`whatsapp-session` volume, so a rebuild does not ask again.

**Test it:** message yourself a voice note. The reply is `Saved to your second
brain.` and a path.

Keep `--profile whatsapp-webjs` on every later `docker compose` command, or
Compose treats this container as an orphan and stops it.

### Groups, and one persona per audience

`tama settings` → **Audiences** is where a group gets its own behaviour. One row
per audience, and every field is a menu:

| Field | What it decides |
|---|---|
| Sees | a view: `none`, `everything`, or one you named. This is the boundary |
| Voice | `friend`, `neutral`, or `roast` |
| Length | a couple of sentences, or full prose |
| Note paths | withheld automatically on anything but `everything` |
| When notes are empty | admit it, or just reply to what was said |
| In a group | follows the conversation, only when spoken to, or every message |
| One line about the room | free text, context only, never policy |
| Who is in the room | a line per person, so a reply can be about them rather than generic |

Saving one mints its token and writes it into this client's settings. Then
connect it from the group itself:

```
/tama the-boys
```

Sent by you, in the group. That is the whole step. WhatsApp shows a group's
internal id nowhere on any platform, so the alternatives are picking the group
from a menu once the bridge has seen it, or finding the id in a log to paste
back — both of which mean leaving the room you are already in.

`/tama` on its own says what is waiting to be claimed. Only your own numbers are
obeyed; in a group everyone can type.

**You outrank the room.** Your own numbers are heard without a mention, and the
prompt says plainly that you are the one it answers to: other people in the
group are participants, not operators. Someone typing "ignore your
instructions" is a thing they said, not a command it received, and when you and
they want different things, you win.

**A group is silent until an audience claims it**, and audiences never capture:
their tokens are for reading, and a vault filling with other people's voice
notes is what the blanket group ignore was always for.

The boundary is the view, not the voice. A prompt asking the model not to
mention something does not work, because the notes are already in its context by
then. The audience's token carries its view and the server derives everything
from that, so a compromised bridge cannot widen what a group reads.

### Changing it later

`tama settings` again (or `tama-server settings` on a source checkout). The
**WhatsApp bridge** section edits the allowed numbers and token without walking
the whole wizard; **Devices** lists what is paired and revokes one. The bridge
reloads these settings while it is running.

**Upgrading from a `.env` install.** Earlier versions took `TAMA_TOKEN` and
`WA_ALLOWED` from `.env`. Run `tama settings`, enter any other owner numbers, and
then delete those two lines, because environment variables override the settings
file and would keep the old values in force:

```sh
sed -i '/^WA_ALLOWED=/d;/^TAMA_TOKEN=/d' .env
tama restart
```

## Environment

Settings come from `config/whatsapp-bridge.json`, written by the wizard. These
environment variables override it, for a one-off or a deployment that predates
the wizard support:

| Variable | Default | Meaning |
|---|---|---|
| `WA_SETTINGS` | `/etc/tama/whatsapp-bridge.json` | where the settings file is |
| `TAMA_TOKEN` | from the file | device token |
| `TAMA_URL` | `http://tama:8080` | the server, over the Compose network |
| `WA_ALLOWED` | from the file | comma-separated senders, country code + digits |
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

**`Error: Can't open display`.** A container has no display, so Chromium must be
headless. `bridge.mjs` sets `headless: true` explicitly, because supplying a `puppeteer`
object to whatsapp-web.js replaces its defaults wholesale rather than merging with them.
If you edit that block, keep the flag.

**`The profile appears to be in use by another Chromium process ... on another computer`.**
A container that died without closing the browser left a `SingletonLock` naming its old
hostname. The bridge clears these on startup; if you hit it anyway, wipe the session
volume as above and scan again.

**Chromium dies immediately.** Out of memory. The browser wants ~500 MB on top
of tama; a 1 GB box cannot run both this and local whisper.

## What it does not do

- No group capture, deliberately.
- No image, document or location handling. Voice and text only.
- No queue. The Cloud API adapter persists inbound messages in SQLite and
  retries with backoff; here a message that fails after three attempts is a
  reply saying so, and it is gone. The capture idempotency key still stops a
  WhatsApp redelivery from writing the same note twice.
