# Claude Desktop extension

Install one file, paste two values, and Claude can search your notes and record
what a session did. No terminal config, no OAuth, no domain.

It is a **client**, like `clients/whatsapp-webjs` and `clients/ios-shortcut`. It
holds a device token and talks to the public `/mcp` route. The server needs no
configuration for it to exist.

## Why a local bundle and not a remote connector

Claude's **custom connectors** are dialled from Anthropic's servers, not from
your computer. A vault on a tailnet, a LAN or `127.0.0.1` is unreachable from
there however correct the URL is, so a remote connector would mean putting the
notes on the public internet behind a domain, TLS and an OAuth 2.1 flow.

An `.mcpb` bundle runs **on your machine** over stdio. So it can reach a server
only you can reach, and the tunnel that `tama expose` already sets up is enough.
That is the whole reason this shape was chosen:

|  | This bundle | A remote connector |
|---|---|---|
| Reaches a private server | **yes** | no, dialled from Anthropic |
| Domain + TLS | not needed | required |
| OAuth 2.1 + client registration | not needed | required |
| Auth | the device token you already mint | OAuth |
| Works in claude.ai web and mobile | no, desktop only | yes |
| Install | double-click a file | paste a URL |

Anthropic's own guidance names this pattern: bundles are how you reach "systems
behind your firewall" and get "full control over authentication".

## What it is

Four files, one of which is an icon. `server/relay.mjs` forwards one JSON-RPC
message to `/mcp` and hands back one reply; `server/index.mjs` is the stdio
pipe around it. No MCP SDK: the stdio transport is newline-delimited JSON-RPC
and tama answers one object per POST, so there is no framing to library away.
The server half is hand-rolled for the same reason — see `docs/mcp.md`.

It owns no vault, no database and no logic. It cannot, and that is the point:
tama's MCP surface is a route on the running daemon precisely so that nothing
launches a second tama against the same SQLite file and the same vault.

## Install

**On the server**, mint a token:

```sh
tama-server connect claude-desktop    # `tama connect` on a Docker deployment
```

It prints once. Add `--as AUDIENCE` to give Claude a slice of the vault rather
than all of it.

**On your computer**: download the bundle and double-click it.

```sh
curl -LO https://github.com/useTama/tama-server/releases/latest/download/tama.mcpb
```

Then fill in the two fields Claude Desktop shows:

| Field | What to put |
|---|---|
| Tama server address | `http://127.0.0.1:8080` if tama runs on this machine, otherwise the address `tama expose` printed |
| Device token | what `connect` just printed |

The token field is marked `sensitive`, so Claude Desktop masks it and stores it
in the OS keychain rather than in a config file.

Node is not a prerequisite: Claude Desktop ships its own on macOS and Windows.

## Build it

```sh
bun run pack:desktop     # -> dist/tama.mcpb
```

`.mcpbignore` keeps the tests out of the archive. The manifest is validated
against the real schema as part of packing, so a broken manifest fails the
build rather than the install.

Releases are built by `.github/workflows/release.yml` on a `v*` tag. It refuses
to publish if the tag and the two manifests disagree on the version, and it
unpacks the archive and runs the entry point before attaching it - because a
bundle that packs cleanly and then cannot start is a failure this repo has
already shipped once, as an image that copied a list of files and missed the
newest one.

## Tests

```sh
cd clients/claude-desktop && bun test
```

They are all about what a failure says. This is the one component whose errors
are read by someone with no server log in front of them: a refused token has to
say "mint a fresh one with `tama-server token claude-desktop`", and an unreachable
address has to name the two traps (Tailscale not running here, `127.0.0.1`
meaning this machine) before someone files a bug about it.
