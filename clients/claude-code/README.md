# Claude Code plugin

Two lines in a terminal and your notes are searchable from any session:

```sh
claude plugin marketplace add useTama/tama-server
claude plugin install tama@usetama --config server_url=YOUR_SERVER --config device_token=YOUR_TOKEN
```

Leave both `--config` flags off and Claude Code prompts for them instead. The
token is declared `sensitive`, so it is masked and not written into a settings
file in the clear.

It is a **client**, like `clients/claude-desktop` and `clients/whatsapp-webjs`.
It holds a device token and talks to the public `/mcp` route.

## Why this and not `claude mcp add`

`claude mcp add --transport http tama URL --header "Authorization: Bearer ..."`
does work, and `docs/mcp.md` section 5b still documents it. But it puts a
bearer token in shell history, has to be repeated per machine, and gives you
nothing but the tools.

The plugin is the same connection with the parts that make it a product:

|  | `claude mcp add` | This plugin |
|---|---|---|
| Token in shell history | yes | no, `sensitive` |
| Per-machine setup | retype the whole line | `claude plugin install` |
| Ships a `/tama:save` command | no | yes |
| Updates | edit by hand | `claude plugin update` |

## What is in it

- **The MCP server**, `.mcp.json`, pointed at `${user_config.server_url}/mcp`
  with the token as a bearer header. All five tools: `search_notes`,
  `read_note`, `append_note`, `record_session`, `today`.
- **`/tama:save`**, a command that records the session. The MCP server's own
  `instructions` already tell a model to record work worth keeping, so this is
  for saying it deliberately rather than hoping.

Always-on cost is about 23 tokens per session (`claude plugin details`). The
tool schemas resolve at runtime and are not paid for until used.

## Reaching the server

Claude Code dials from **your** machine, unlike a Claude custom connector,
which is dialled from Anthropic's servers. So a private address works:
`http://127.0.0.1:8080` if tama runs here, otherwise whatever `tama expose`
printed. Nothing has to be on the public internet.

## Verified against the real client

`server/discover` is worth knowing about. Claude Code probes with it *before*
`initialize`, and tama answers any method it does not implement with a
JSON-RPC `METHOD_NOT_FOUND`. That is fine - the client falls back to
`initialize`, `notifications/initialized`, `tools/list` and connects - but it
means a probe failing in the log is normal rather than a symptom.

## Changing it

```sh
claude plugin validate clients/claude-code     # manifest, commands, agents
claude plugin validate .                       # the marketplace entry too
```

Both run against the real schema, so a broken manifest fails here rather than
at someone else's install. `claude plugin tag` cuts a release tag and checks
that `plugin.json` and the marketplace entry agree on the version - they are
two files with the same number in them, which is the kind of pair that drifts.
