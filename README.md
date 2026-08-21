<img src="https://raw.githubusercontent.com/useTama/tama-server/main/assets/icon.png" width="88" alt="">

# tama-server

Talk into a small device, and a markdown note appears in a folder you own.

Self-hosted, open source, zero recurring cost. Speech-to-text runs locally, and there is no
language model in the capture path, so capture needs no account, no key and no bill.

<a href="https://raw.githubusercontent.com/useTama/tama-server/main/assets/architecture-light.svg">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/useTama/tama-server/main/assets/architecture-dark.svg">
    <img src="https://raw.githubusercontent.com/useTama/tama-server/main/assets/architecture-light.svg" width="820"
         alt="Clients post to tama-server, which runs two paths. Capture is ffmpeg then whisper.cpp then an atomic journalled write, and it writes to your vault. Ask is grep retrieval then an LLM adapter, and it reads from your vault. No language model sits in the capture path.">
  </picture>
</a>

## Quickstart

```sh
brew install bun ffmpeg whisper-cpp          # or the apt/docker equivalents

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

## API

| Route | Auth | Does |
|---|---|---|
| `POST /capture` | device | audio or text in, note path out |
| `POST /ask` | device | ask a question, get an answer from your notes |
| `GET /health` | none | version, min client version, whisper status |
| `POST /pair` | the code | redeem a pairing code for a device token |
| `POST /pair/code`, `/tokens`, `GET /digest` | admin | mint codes, manage tokens, force a digest |

**[Full reference →](docs/api.md)** covers the capture headers your client must send,
the retry policy, and the streaming shape of `/ask`.

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
- **[Issues](https://github.com/useTama/tama-server/issues)** — what is planned and what is broken

## Test

```sh
bun test          # 43 tests
bun run typecheck
```

Firmware lives in [tama-firmware](https://github.com/useTama/tama-firmware).

## Licence

Apache-2.0
