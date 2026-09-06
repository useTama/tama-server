# iOS Shortcuts client

Two shortcuts, no app. **Setup** runs once per phone and pairs it by scanning a QR code.
**Capture** is the one you use every day: record, post, done.

Recording and posting audio from Shortcuts works today — a 3–4 second clip lands as a note
in well under a second on a local network. The part that used to need a terminal was
*pairing*, and [`GET /pair`](../../docs/api.md#get-pair) is what removes it.

| | Setup | Capture |
|---|---|---|
| How often | once per device | every capture |
| Needs | the server's pairing page on screen | nothing |
| Does | scan QR → `POST /pair` → save the device token | record → `POST /capture` → show the transcript |

Bind **Capture** to the Action Button (iPhone 15 Pro and later), a Back Tap, the Lock Screen,
or a Siri phrase. That is the one-press capture.

## Getting them onto the phone

**Build them by hand.** Twelve taps, and it is the only route that cannot break: the
step-by-step is below and it is the source of truth for what these shortcuts do.

**Or sign the files here and send them over.** iOS refuses to import a shortcut nobody has
signed, and a signature is tied to the person who makes it, so this repository cannot ship
one that works for you. On a Mac:

```sh
./sign.sh            # -> dist/Tama Setup.shortcut, dist/Tama Capture.shortcut
```

then AirDrop them. The `.shortcut` files checked in here are plain property lists — readable,
diffable, and the thing `sign.sh` consumes. Signing verifies that a file is intact, not that
its actions are right, so if you have not run these on a device yet, walk through the manual
steps once and compare.

**Or share an iCloud link.** Once you have a working copy, Share → Copy iCloud Link. Since
iOS 15 there is no "Allow Untrusted Shortcuts" toggle to talk anyone through; opening a link
and tapping *Add Shortcut* is the whole thing.

## Pair a device

1. On the machine running tama-server, open the pairing page. `tama-server setup` prints the
   URL, and it looks like `http://192.168.1.20:8080/pair?token=ADMIN_TOKEN`.
2. Pick the address on the page that your phone shares a network with. `localhost` is offered
   last for a reason — it is the one address that cannot work from another device.
3. On the phone, run **Tama Setup** and scan.
4. Name the device. That name lands in the `client:` field of every note it captures.

The code is good for one device and ten minutes. Reload the page for another one.

This step needs the admin to be at the machine, and that is the security boundary doing its
job: if a phone could pair itself, so could anyone else who can reach the port.

## Build Tama Setup by hand

New shortcut, then add these in order. Every action that says *(previous)* just takes the
output above it, which is what Shortcuts does by default.

1. **Scan QR Code**
2. **Get Dictionary from Input** *(previous)*
3. **Get Dictionary Value** — key `url`, from the *Dictionary* above
4. **Set Variable** `TamaURL`
5. **Get Dictionary Value** — key `code`, from the same *Dictionary*
6. **Set Variable** `TamaCode`
7. **Ask for Input** — Text, "Name this device", default `iphone`
8. **Set Variable** `TamaDevice`
9. **Get Contents of URL**
   - URL `TamaURL/pair`
   - Method **POST**, Request Body **JSON**
   - `code` → `TamaCode`, `deviceName` → `TamaDevice`
10. **Get Dictionary Value** — key `token`
11. **Set Variable** `TamaToken`
12. **Text** — `{"url":"TamaURL","token":"TamaToken","device":"TamaDevice"}`, with each name
    inserted as a variable, not typed
13. **Save File** — to `iCloud Drive/Shortcuts/tama.json`, *Ask Where to Save* off,
    *Overwrite If File Exists* on
14. **Show Result** — `TamaToken`, so a blank one tells you the code was already used

## Build Tama Capture by hand

1. **Get File** — `iCloud Drive/Shortcuts/tama.json`, *Show Document Picker* off
2. **Get Dictionary from Input** *(previous)*
3. **Get Dictionary Value** `url` → **Set Variable** `TamaURL`
4. **Get Dictionary Value** `token` → **Set Variable** `TamaToken`
5. **Record Audio** — start *Immediately*, stop *On Tap*
6. **Get Contents of URL**
   - URL `TamaURL/capture`
   - Method **POST**, Request Body **File**, file = the *Recording* above
   - Header `Authorization` → `Bearer TamaToken`
7. **Get Dictionary Value** — key `text`
8. **Show Notification** *(previous)*

That is a working capture. Two things are worth adding once it works:

- An **Idempotency-Key** header. A retry after a dropped response must not write the note
  twice, and on a phone that leaves a lift or a train it will happen. Shortcuts has no UUID
  action, so: **Current Date** → **Format Date** (custom, `yyyyMMdd-HHmmss`) →
  `TamaStamp`, **Random Number** 100000–999999 → `TamaNonce`, then send
  `TamaStamp-TamaNonce`. Retry with the *same* key; the server returns the original note
  rather than making another.
- An **X-Tama-Captured-At** header holding the current date, so a capture that queues while
  you are offline is filed at the time you spoke, not the time it arrived.

The files in this directory include both.

## What the server expects

Full detail in [docs/api.md](../../docs/api.md). The short version:

| | |
|---|---|
| QR payload | `{"v":1,"url":"http://host:port","code":"807390"}` |
| Pair | `POST {url}/pair`, JSON `{"code","deviceName"}` → `{"token"}`, shown once |
| Capture | `POST {url}/capture`, `Authorization: Bearer <token>`, body = the audio file |
| Answer | `{"ok":true,"path":"Inbox/…","text":"…","ms":420}` |

Audio goes as the raw request body in whatever format Shortcuts recorded — the server hands
it to ffmpeg, which reads what the phone produces.

On failures: `401` means stop and pair again, never retry. `413` and `422` mean drop it and
say so — `422` is specifically *no speech was heard*, so the mic was muted or nothing was
said. `503` and `5xx` mean retry with the same idempotency key.

## When it does not work

**"Could not connect"** — the phone is on a different network from the server, or the QR
carried an address the phone cannot route to. Reload the pairing page and pick a different
address; `192.168.x.x` and `10.x.x.x` are the ones a phone on the same Wi-Fi can reach.

**A blank token after Setup** — the code was already used or the ten minutes ran out. Codes
are single-use on purpose. Reload the page.

**`unauthorized` from Capture** — the token was revoked (`DELETE /tokens/:id`) or
`tama.json` never got written. Run Setup again.

**Nothing written, and a note about nothing being heard** — that is `422`. The server heard
silence, so it wrote nothing rather than filing an empty note.

**Setup cannot find the QR** — every field is on screen as text too. Type the six digits into
the `code` field of the Get Contents of URL action, and the address into `TamaURL`.

## Why a file rather than a stored variable

Shortcuts variables do not survive the end of a run, so the device token has to live
somewhere. `iCloud Drive/Shortcuts/tama.json` is the one place both shortcuts can reach
without a third-party app. It syncs, which means pairing once covers your other devices —
and also means the token is in iCloud, so revoke it (`DELETE /tokens/:id`) if that is not
what you want.
