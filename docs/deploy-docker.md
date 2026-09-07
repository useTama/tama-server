# Deploy tama-server with Docker

A complete walkthrough for putting Tama on a Linux server (Ubuntu 22.04/24.04, tested on an
EC2 instance) using the Dockerfiles in this repo. Two containers: `tama` (the server) and
`whisper` (whisper.cpp's HTTP server). Notes live in a Docker volume that is a git repo.

Nothing in this guide uploads your notes anywhere.

Assumed: you can SSH into the box and run `sudo`. Everything else is checked before it is
installed.

Both images build on `x86_64` and `aarch64` (Graviton) — whisper.cpp compiles from source and
picks up NEON on ARM, so an ARM instance is if anything the faster one per rupee.

---

## 0. What you will end up with

```
                 :443 ──► caddy ──► tama:8080 ──┬──► a transcription API (default)
                 (TLS)              │           └──► whisper:8081  (opt-in, --profile local-stt)
                                    ├── volume tama-vault  → /vault  (your notes, git-tracked)
                                    └── volume tama-data   → /data   (tokens, pairing, capture log)
```

**Transcription is an API call by default.** One small image, about a minute to build, and
your server does no inference. Local whisper is one flag away when you want it, and the
trade is stated plainly in step 5.

Caddy is optional and only needed for pairing a phone from outside the LAN, or for WhatsApp.
Steps 1–8 give you a working server; step 9 adds HTTPS.

---

## 1. Check what is already on the box

Install nothing yet. Paste this and read the output.

```sh
. /etc/os-release; echo "$PRETTY_NAME $(uname -m)"; nproc; free -h | sed -n 2p; df -h / | tail -1

command -v docker && docker --version || echo "docker: MISSING"
docker compose version 2>/dev/null || echo "compose plugin: MISSING"
docker info >/dev/null 2>&1 && echo "daemon: OK as $(id -un)" || echo "daemon: needs sudo / docker group"

docker ps -a 2>/dev/null
ss -lntp 2>/dev/null | grep -E ':(80|443|8080|8081)\b' || echo "80/443/8080/8081 free"

for b in git curl openssl jq; do command -v $b >/dev/null && echo "$b: present" || echo "$b: MISSING"; done
```

The repo also ships this as `docker/preflight.sh` once you have cloned it.

Decide three things from that output:

| Output says | Do |
|---|---|
| `docker --version` prints a version | skip step 2 |
| `daemon: needs sudo / docker group` | run only the `usermod` line in step 2 |
| RAM under 2 GB | use `ggml-base.bin` in step 6, not `ggml-small.bin` |
| `8080` already listening | change the published port in step 6 |

Disk: the whisper build plus the model needs roughly 4 GB free during build, ~1.5 GB after.

---

## 2. Install Docker — only if step 1 said it is missing

```sh
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"
newgrp docker          # or log out and back in
docker run --rm hello-world
```

If Docker was present but the daemon was unreachable, run only the `usermod` + `newgrp` lines.

---

## 3. Get the code

```sh
mkdir -p ~/tama && cd ~/tama
git clone https://github.com/useTama/tama-server.git .
```

Cloning into a non-empty directory fails; `.` on an empty `~/tama` is the intent.

---

## 4. Generate the admin token and the config

```sh
cp tama.config.docker.json tama.config.json
sed -i "s|REPLACE: openssl rand -hex 24|$(openssl rand -hex 24)|" tama.config.json
chmod 600 tama.config.json
cat tama.config.json
```

You should see paths that are *container* paths, not host paths:

```json
{
  "vault":  { "path": "/vault", "inbox": "Inbox" },
  "dataDir": "/data",
  "stt":    { "provider": "whisper-cpp", "url": "http://whisper:8081" },
  "server": { "port": 8080, "adminToken": "…64 hex chars…" }
}
```

`tama.config.json` is the admin credential for the whole vault. It is git-ignored; keep it
that way and do not copy it into an image.

Save the token somewhere you can paste from:

```sh
ADMIN=$(grep -o '"adminToken": *"[^"]*"' tama.config.json | cut -d'"' -f4); echo "$ADMIN"
```

> Do not run `tama-server setup` here. The wizard is for an interactive install; a container
> deployment configures by file, which is what this step did.

---

## 5. Choose how audio gets transcribed

This is the one real decision in the deploy. Everything else is mechanical.

| | Default: a transcription API | Opt-in: local whisper |
|---|---|---|
| Build | ~1 min, one small image | 5–15 min, compiles whisper.cpp |
| Server load | none — an HTTP call | a CPU core and ~2 GB resident per transcription |
| Cost | per minute of audio | zero, forever |
| Privacy | **recordings are uploaded to the provider** | nothing leaves the machine |
| Speed | usually faster than CPU whisper | depends on your cores |

### Option A — a transcription API (default)

Pick a provider and put the key in `.env`, never in the config file:

```sh
cd ~/tama
echo 'GROQ_API_KEY=gsk_your_key_here' > .env    # console.groq.com/keys
chmod 600 .env
```

The shipped `tama.config.json` already points at Groq. To use a different one, edit its `stt`
block:

```jsonc
// OpenAI
"stt": { "provider": "openai-compatible", "url": "https://api.openai.com/v1",
         "model": "whisper-1", "apiKeyEnv": "OPENAI_API_KEY" }

// Sarvam — Indian languages and code-mixed Hindi-English, where whisper is weaker.
// url and model default; language may be hi-IN, en-IN, ta-IN, … or unknown to auto-detect.
"stt": { "provider": "sarvam", "model": "saaras:v3", "language": "unknown",
         "apiKeyEnv": "SARVAM_API_KEY" }
```

`docker-compose.yml` already passes `GROQ_API_KEY`, `OPENAI_API_KEY` and `SARVAM_API_KEY`
through; set the one you use in `.env` and leave the rest unset.

### Option B — local whisper (nothing leaves the machine)

It lives behind a Compose profile, so it is never built or started unless you ask:

```sh
docker compose --profile local-stt up -d --build
```

Then point the config at it — no key, no `.env`:

```json
"stt": { "provider": "whisper-cpp", "url": "http://whisper:8081" }
```

Model size is the `MODEL` build arg on the `whisper` service:

| Model | RAM | Speed on 2 vCPU | Use when |
|---|---|---|---|
| `ggml-base.bin` | ~1 GB | ~4× realtime | 1–2 GB box |
| `ggml-small.bin` (default) | ~2 GB | ~2× realtime | 2 GB+, the sane default |
| `ggml-medium.bin` | ~5 GB | slower than realtime | only with a GPU |

The model is baked into the image deliberately, so a restart never re-downloads 500 MB.
Changing it means `docker compose --profile local-stt build whisper` again.

Remember to keep `--profile local-stt` on every later `docker compose` command, or Compose
treats the whisper container as an orphan and stops it.

---

## 6. Build and start

```sh
cd ~/tama
docker compose up -d --build
```

With the default API transcription this is about a minute. With `--profile local-stt` the
first build compiles whisper.cpp and downloads the model: **5–15 minutes** on a small
instance, near-silent for most of it. Later builds are cached either way.

Watch it come up:

```sh
docker compose ps
docker compose logs -f tama
```

Healthy output ends with a line like:

```
tama-server 0.1.0   http://127.0.0.1:8080
```

The entrypoint runs `git init /vault` the first time, so the vault passes Tama's
git-backed-vault check without you doing anything.

---

## 7. Verify it actually works

```sh
curl -s localhost:8080/health | jq
```

The `stt` field must report reachable. On the API path that means the provider answered; on
`--profile local-stt` it means the whisper container is up. If it does not, jump to
Troubleshooting.

Now a real end-to-end capture. Mint a device token from the terminal:

```sh
CODE=$(curl -s -X POST localhost:8080/pair/code -H "Authorization: Bearer $ADMIN" | jq -r .code)
TOKEN=$(curl -s -X POST localhost:8080/pair -H 'content-type: application/json' \
  -d "{\"code\":\"$CODE\",\"deviceName\":\"server-test\"}" | jq -r .token)
echo "$TOKEN"
```

Capture text (no audio, no model involved):

```sh
curl -s -X POST localhost:8080/capture \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H "Idempotency-Key: $(openssl rand -hex 8)" \
  -d '{"text":"first note from the server"}'
```

Then confirm the file landed in the vault:

```sh
docker compose exec tama ls -R /vault/Inbox
docker compose exec tama cat /vault/Inbox/*.md | head
```

Capture audio, if you have a file to hand:

```sh
curl -s -X POST localhost:8080/capture -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: $(openssl rand -hex 8)" \
  --data-binary @sample.m4a
```

The first audio capture is slow — whisper loads the model on first inference.

---

## 8. Import an existing second brain (optional)

Copy your Markdown to the server first (this uploads to *your* box, nowhere else):

```sh
# from your laptop
rsync -av --prune-empty-dirs --include '*/' --include '*.md' --exclude '*' \
  ~/Obsidian/ ubuntu@YOUR_SERVER:~/tama-import/
```

Then import it into the vault volume:

```sh
cd ~/tama
docker compose run --rm -v "$HOME/tama-import:/import:ro" tama \
  bun run src/tama.ts import /import
```

It preserves relative paths (so `[[wiki-links]]` keep resolving), never overwrites a
different file, and makes no network requests. Details in [import.md](import.md).

Commit the imported notes so the vault's git history has a baseline:

```sh
docker compose exec tama sh -c 'git -C /vault add -A && git -C /vault commit -qm "import" && git -C /vault log --oneline | head -1'
```

---

## 9. Public HTTPS (needed for phone pairing off-LAN, and for WhatsApp)

First, find out whether anything already owns 80/443 — step 1 tells you, but not *what*:

```sh
sudo ss -lntp | grep -E ':(80|443)\b'
```

**If they are free**, use the bundled Caddy. Prerequisites: a domain, an A record pointing at
the server's public IP, and ports 80 and 443 open in the EC2 security group.

```sh
cd ~/tama
echo "TAMA_DOMAIN=tama.example.com" > .env
docker compose -f docker-compose.yml -f docker-compose.caddy.yml up -d
docker compose logs -f caddy      # watch the certificate get issued
curl -s https://tama.example.com/health | jq
```

Caddy gets a Let's Encrypt certificate automatically on first request. Certificate failures
are almost always DNS not yet propagated or port 80 closed.

Use this same two-file `-f` invocation for every later `docker compose` command, or the Caddy
container will be stopped as an orphan.

**If a proxy already holds 80/443** (another container, or nginx/caddy on the host), do not
start the bundled Caddy — two things cannot bind the same port. Add a vhost to the existing
proxy pointing at `127.0.0.1:8080` instead, which is exactly where step 6 published Tama:

```nginx
# nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_read_timeout 300s;      # CPU transcription is slower than the default 60s
    client_max_body_size 50m;     # audio uploads
}
```

```caddyfile
# host Caddy
tama.example.com {
    reverse_proxy 127.0.0.1:8080 {
        transport http { read_timeout 300s }
    }
}
```

If the existing proxy runs in a container, `127.0.0.1` is that container's own loopback — use
`host.docker.internal:8080` with `extra_hosts: ["host.docker.internal:host-gateway"]`, or put
both on the same Docker network and target `tama:8080`.

Security group, minimal: 22 from your IP, 80 and 443 from anywhere. **Never** open 8080 —
`docker-compose.yml` publishes it on `127.0.0.1` only, and it is plain HTTP.

---

## 10. Pair a phone

```
https://tama.example.com/pair?token=PASTE_ADMIN_TOKEN
```

Open that in a browser. It draws a QR code holding the server address and a one-time code.
Scan it with the **Setup** shortcut in [`clients/ios-shortcut`](../clients/ios-shortcut), then
bind **Capture** to the Action Button.

That URL contains the admin token, so treat it as the token itself: no bookmarks, no sharing,
no screenshots into a group chat. Each load mints a fresh code; codes are single-use and
expire in 10 minutes.

**Known caveat behind a reverse proxy:** the server sees Caddy's plain-HTTP request, so the QR
may encode `http://tama.example.com` instead of `https://`. If the phone then fails to post,
pair from the terminal instead — mint the token as in step 7, and enter the `https://` URL and
token into the shortcut by hand.

Manage devices:

```sh
curl -s localhost:8080/tokens -H "Authorization: Bearer $ADMIN" | jq
curl -s -X DELETE localhost:8080/tokens/DEVICE_ID -H "Authorization: Bearer $ADMIN"
```

---

## 11. Optional: turn on /ask

Capture never touches a language model. `/ask` answers 501 until you add an `ask` block.
Add to `tama.config.json`:

```json
"ask": { "provider": "anthropic", "model": "claude-sonnet-5", "apiKeyEnv": "ANTHROPIC_API_KEY", "maxChunks": 8 }
```

Put the key on the container, not in the config file — add to the `tama` service in
`docker-compose.yml`:

```yaml
    environment:
      TAMA_CONFIG: /etc/tama/tama.config.json
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:?}
```

and put `ANTHROPIC_API_KEY=sk-ant-…` in `.env` (git-ignored). Then:

```sh
docker compose up -d
curl -s -X POST localhost:8080/ask -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"question":"what did I capture first?"}' | jq
```

Retrieval is grep, not embeddings — nothing to index or rebuild.

---

## 12. Optional: push notifications

In `tama.config.json`:

```json
"notify": { "provider": "ntfy", "ntfy": { "url": "https://ntfy.sh", "topic": "SOMETHING-UNGUESSABLE" }, "digestAt": "08:00" }
```

Generate the topic (`openssl rand -hex 12`), subscribe to it in the ntfy app, `docker compose
up -d`. Anyone who knows a public ntfy topic can read it — the topic is the password.

---

## 13. Optional: WhatsApp

Requires step 9 (public HTTPS). Full Meta-side walkthrough is in
[api.md#whatsapp-cloud-api](api.md#whatsapp-cloud-api). The container-specific parts:

`tama.config.json`:

```json
"whatsapp": {
  "phoneNumberId": "123456789012345",
  "allowedFrom": ["919876543210"],
  "publicBaseUrl": "https://tama.example.com",
  "accessTokenEnv": "WHATSAPP_ACCESS_TOKEN",
  "appSecretEnv": "WHATSAPP_APP_SECRET",
  "verifyTokenEnv": "WHATSAPP_VERIFY_TOKEN",
  "graphApiVersion": "v23.0"
}
```

`.env`, with a verify token you generate (`openssl rand -hex 32`):

```
WHATSAPP_ACCESS_TOKEN=…
WHATSAPP_APP_SECRET=…
WHATSAPP_VERIFY_TOKEN=…
```

Pass all three through in the `tama` service's `environment:`, restart, and confirm
`whatsapp.available: true` in `/health`. The callback URL for Meta is
`https://tama.example.com/webhooks/whatsapp`; subscribe the WhatsApp Business Account to
`messages`.

---

## 14. Backups

The vault is a git repo inside the `tama-vault` volume. Two things to do:

**Commit on a schedule** — `crontab -e`:

```
0 * * * * cd $HOME/tama && docker compose exec -T tama sh -c 'git -C /vault add -A && git -C /vault diff --cached --quiet || git -C /vault commit -qm "hourly $(date -I)"'
```

**Get a copy off the box** — either add a private git remote and push, or snapshot the volume:

```sh
docker run --rm -v tama_tama-vault:/vault:ro -v "$PWD":/out alpine \
  tar czf /out/tama-vault-$(date -I).tgz -C /vault .
```

Back up `tama.config.json` and the `tama-data` volume too — `tama-data` holds device tokens.
Losing it means re-pairing every device; losing the vault means losing notes.

Check the volume names on your box with `docker volume ls` — Compose prefixes them with the
project directory name.

---

## 15. Day-to-day operations

```sh
cd ~/tama

docker compose ps                    # what is running
docker compose logs -f tama          # follow the server
docker compose logs --tail 100 whisper
docker compose restart tama          # after a config edit
docker compose down                  # stop, volumes survive
docker compose down -v               # stop AND DELETE the vault. do not.
```

Config changes need a restart; the file is mounted read-only and read at boot.

**Update to a new version:**

```sh
cd ~/tama
git pull
docker compose up -d --build tama    # whisper image is untouched, so this is fast
curl -s localhost:8080/health | jq .version
```

---

## Troubleshooting

**`stt` unreachable on the API path.**
The key is wrong or absent. `docker compose exec tama env | grep API_KEY` shows what actually
reached the container — an empty value means `.env` is missing or the variable name does not
match the config's `apiKeyEnv`.

**`stt` unreachable on `--profile local-stt`.**
`docker compose --profile local-stt logs whisper`. Out-of-memory on a small instance is the
usual cause — the container is killed with no message. Switch `MODEL` to `ggml-base.bin` and
rebuild. Also check the config says `http://whisper:8081`, not `127.0.0.1`: inside the tama
container, loopback is the tama container.

**Sarvam returns 401 but the key looks right.**
Sarvam authenticates with `api-subscription-key`, not `Bearer`. Tama handles that, but only
when `provider` is `sarvam` — an `openai-compatible` block pointed at Sarvam's URL will fail
this way.

**`vault at /vault is not git-tracked`.**
The entrypoint's `git init` did not run — you are on an older image. Fix it directly:

```sh
docker compose exec tama git init /vault && docker compose restart tama
```

**`ffmpeg failed` on audio capture.**
The upload was not audio, or was truncated. Test with a known-good file; text capture
(step 7) isolates whether the problem is audio-specific.

**401 on every request.**
The token is wrong or revoked. Admin routes need the `adminToken` from `tama.config.json`;
`/capture` and `/ask` need a *device* token from pairing. They are not interchangeable.

**Capture returns 503, or is very slow.**
Whisper is loading the model (first request) or the box is out of CPU. `docker stats` while
posting shows which.

**Caddy will not get a certificate.**
`dig +short tama.example.com` must return the server's public IP, and port 80 must be open in
the security group — Let's Encrypt validates over HTTP first.

**Permission errors writing the vault.**
The container runs as root against root-owned volumes by design. If you switched to a bind
mount instead, `chown -R 0:0` the host directory or run the container as your UID.

**Everything looks fine but no note appears.**
Check `safety.dryRun` in `tama.config.json` is `false`.
