<img src="https://raw.githubusercontent.com/useTama/tama-server/main/assets/icon.png" width="88" alt="">

# tama-server

Talk into a small device, and a markdown note appears in a folder you own.

Self-hosted, open source, zero recurring cost. Speech-to-text runs locally, and there is no
language model in the capture path, so capture needs no account, no key and no bill.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/useTama/tama-server/main/scripts/install.sh | sh
tama-server setup
```

The installer builds from source — it needs `git` and [bun](https://bun.sh) — and puts the
binary in `~/.local/bin`. Set `PREFIX` to put it somewhere else. Audio capture also needs
`ffmpeg`; setup says so if it is missing.

## First-time setup

`tama-server setup` creates a new empty git-tracked vault (or uses an existing git-backed
vault) and a private configuration file. Its **Existing notes** step can import an Obsidian
vault or any Markdown folder directly into the new Tama vault.

For transcription, choose whisper.cpp on this machine, whisper.cpp on another machine, or a
hosted API — Groq and OpenAI, whose speech models setup lists for you, or Sarvam for Indian
languages and code-mixed speech. If you pick this machine
and nothing is listening yet, setup offers to download a model and install a per-user service
so Whisper starts with you — no root, and it tells you the command to undo it.

For `/ask`: keep it disabled, use any local OpenAI-compatible model server, or select a cloud
API. Setup accepts hidden API keys and saves them in separate owner-readable files (not
encrypted) beside the config. Environment-variable references remain supported for manual
deployments. The wizard checks connectivity, lists chat models when supported, and offers a
short model test.

The same wizard can optionally connect a WhatsApp Cloud API number. It collects the phone-number
ID and sender allowlist, hides the Meta credentials, saves each secret in its own owner-readable
file, verifies the number/token when Meta is reachable, and prints the callback URL and generated
webhook verify token to paste into Meta. It finishes by printing the commands that pair your first
device.

Re-run `tama-server setup` to change configuration. It changes vault contents only when you
explicitly select the import option.
The generated config lives at `~/.config/tama/tama.config.json`; server deployments can
override that with `$TAMA_CONFIG` or `--config PATH`, which both the server and setup accept.

Already have a Markdown second brain? Choose the import option in setup, or run
`tama-server import /path/to/notes` later.
It preserves note paths, never overwrites a different file, and does not push or upload anything.
For a remote machine, the **[private deployment import guide](docs/import.md)** shows an SSH-only
workflow with no GitHub remote.

<a href="https://raw.githubusercontent.com/useTama/tama-server/main/assets/architecture-light.svg">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/useTama/tama-server/main/assets/architecture-dark.svg">
    <img src="https://raw.githubusercontent.com/useTama/tama-server/main/assets/architecture-light.svg" width="820"
         alt="Clients post to tama-server, which runs two paths. Capture is ffmpeg then whisper.cpp then an atomic journalled write, and it writes to your vault. Ask is grep retrieval then an LLM adapter, and it reads from your vault. No language model sits in the capture path.">
  </picture>
</a>

## From a source checkout

```sh
brew install bun ffmpeg whisper-cpp          # or the apt/docker equivalents
bun install
bun run setup                                # same wizard, no install step
bun run start
```

Or configure it by hand, which is what a scripted deployment wants:

```sh
mkdir -p ~/.local/share/whisper              # one model, once
curl -L -o ~/.local/share/whisper/ggml-small.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin

mkdir -p ~/tama-vault/Inbox                  # a plain folder you own
git -C ~/tama-vault init                     # git-tracked, never a cloud-sync folder

cp tama.config.example.json tama.config.json # set vault.path, and an adminToken:
openssl rand -hex 24                         #   -> server.adminToken

whisper-server -m ~/.local/share/whisper/ggml-small.bin --host 127.0.0.1 --port 8081
bun run dev
```

`ggml-base.bin` on a Raspberry Pi or a 1 GB box. `large-v3` wants a real GPU.

Then [pair a device](docs/api.md#pairing) and post to it.

## Run as a service

For a long-running install, use the included [systemd unit](deploy/tama-server.service)
or [macOS LaunchAgent](deploy/com.usetama.server.plist). Copy one to the platform's
service directory, set its absolute paths and the `TAMA_CONFIG` environment variable, then
enable it. Both templates run the compiled binary and send `SIGTERM` for graceful shutdown.

You can also choose a config file directly:

```sh
bun run start -- --config /etc/tama/tama.config.json
# or: TAMA_CONFIG=/etc/tama/tama.config.json bun run start
```

## API

| Route | Auth | Does |
|---|---|---|
| `POST /capture` | device | audio or text in, note path out |
| `POST /ask` | device | ask a question, get an answer from your notes |
| `GET /health` | none | version, min client version, whisper status |
| `GET /pair` | admin | a QR code to point a phone at |
| `POST /pair` | the code | redeem a pairing code for a device token |
| `POST /pair/code`, `/tokens`, `GET /digest` | admin | mint codes, manage tokens, force a digest |

**[Full reference →](docs/api.md)** covers the capture headers your client must send,
the retry policy, and the streaming shape of `/ask`.

## Pairing a phone

`tama-server setup` prints a link to `/pair`. Open it and the server draws a QR code holding
its own address and a one-time pairing code. Scan it, and the device has a token.

[`clients/ios-shortcut`](clients/ios-shortcut) is two iOS Shortcuts built on that: **Setup**
scans the code once, **Capture** records and posts. Bind Capture to the Action Button and a
note is one press away. No app, no terminal, no token typed into a phone.

First pairing still needs the admin to show that QR, which is the point — if a phone could
pair itself, so could anyone else who can reach the port.

## WhatsApp

Tama can optionally sit behind a dedicated WhatsApp Business Platform number. Send that number a
voice note to capture it; send text to ask the second brain and receive the answer in the chat.
Only explicitly allowlisted sender numbers can do either.

This uses Meta's official WhatsApp Cloud API and needs a public HTTPS webhook plus Meta credentials;
it is not enabled by default and does not change local capture. See the
**[WhatsApp setup and security guide](docs/api.md#whatsapp-cloud-api)** for the config and webhook
steps.

## Asking questions

Optional, and the only place a model enters. With no `ask` block configured `/ask` answers
501 and everything else keeps working with no key.

| Option | Cost | Privacy | Quality |
|---|---|---|---|
| **Ollama** (default) | free | nothing leaves the machine | weakest |
| Gemini free tier | free | ⚠️ Google trains on your prompts, and the retrieved notes *are* the prompt | good |
| Anthropic, or any paid tier | per token | not trained on | best |

Ollama is the default on purpose. A tool that promises your notes stay put should not ship
pointing at a vendor that learns from them.

Retrieval is grep, not embeddings. No index to build, corrupt, or rebuild.

## Docs

- **[Architecture](ARCHITECTURE.md)** — the two paths, the vault adapter, and the seven vault invariants
- **[API reference](docs/api.md)** — every route, header and status code
- **[Import existing notes](docs/import.md)** — local and private-SSH migration, with no upload
- **[Issues](https://github.com/useTama/tama-server/issues)** — what is planned and what is broken

## Test

```sh
bun test          # 106 tests
bun run typecheck
```

Clients live in [`clients/`](clients). Firmware lives in
[tama-firmware](https://github.com/useTama/tama-firmware).

## Licence

Apache-2.0
