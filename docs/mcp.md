# The MCP surface

Tama exposes your vault as tools, so an agent in your editor can search your
notes before it starts and write to them as it goes.

This document is written to be learned from as much as followed: each section
says what the thing is, then why tama does it this particular way.

---

## 1. What MCP actually is

Model Context Protocol is a convention for letting a model call your software.
Strip away the vocabulary and it is three HTTP requests:

| Request | Meaning |
|---|---|
| `initialize` | who are you, what can you do |
| `tools/list` | describe your tools |
| `tools/call` | run this one, with these arguments |

The wire format is [JSON-RPC 2.0](https://www.jsonrpc.org/specification): every
message is `{"jsonrpc":"2.0","id":1,"method":"...","params":{...}}` and every
reply is `{"jsonrpc":"2.0","id":1,"result":{...}}`. That is the whole protocol
for a server that only offers tools.

The part that is not plumbing is the **tool descriptions**. The model decides
whether to call a tool by reading its description, so a vague one is never
called and an eager one is called every turn and burns tokens. Both failures
are silent. In `src/mcp.ts` the descriptions are longer than the code they
guard, and that is the correct ratio.

## 2. The five tools

```
search_notes(query, limit)                        GrepRetriever.search()
read_note(path)                                   a confined file read
append_note(path, text)                           Vault.appendMarkdown()
record_session(project, summary, shipped, ...)    appendSession()
today()                                           the captures table + project logs
```

Every one is a wrapper. The capabilities were built and tested as HTTP routes
first, so MCP is a second doorway onto the same rooms rather than a second
implementation of them. That is why `src/mcp.ts` is short, and it is the reason
to build features as routes before exposing them here.

**Reading and writing are different in kind.** `search_notes` and `read_note`
are what make an agent useful at the start of a session: it can find out what
you already decided instead of asking you. `record_session` is what makes the
session worth having later. `append_note` is for "remember this".

## 3. Why a route on the running server

An MCP client normally *launches* a stdio server as a subprocess. If tama did
that, every client would start a **second tama** against the same SQLite file
and the same vault: two preflights, two digest schedulers, two writers to one
database. tama is already a daemon, so the protocol gets a route on the process
that is already running.

For a client that only speaks stdio, `mcp-proxy` bridges to this route rather
than spawning a second instance.

SSE is not implemented: it is deprecated in the spec. Streamable HTTP allows a
plain JSON response when a tool does not stream, and none of these five do.

## 4. Auth, and why there is no OAuth

`/mcp` sits *after* the bearer check that `/capture` and `/ask` already use, so
there is one auth surface rather than two:

```
Authorization: Bearer <device token>
```

The spec's OAuth 2.1 mandate applies to servers "accessible over the internet"
or "intended for public use". A personal daemon on a loopback port with a
static token is explicitly sufficient, and Home Assistant does the same with
long-lived tokens. Adding OAuth here would be ceremony that protects nothing.

**A token can be scoped.** Because audiences and views already exist, an MCP
token can see a slice of the vault:

```sh
tama settings          # Audiences -> add -> view: work -> mint its token
```

An agent working in a client repo then gets `Projects/**` and `Work/**` and
cannot search your job applications. It also cannot write: `append_note` and
`record_session` refuse a token with an audience, because a scoped reader
putting entries into someone's notes is a different kind of access than reading
them.

## 5. Connecting a client

Two clients, one for each place a session actually happens. Both dial from the
user's own machine, so both reach a server only that user can reach, and
neither needs a domain or an OAuth flow.

### The terminal

```sh
claude plugin marketplace add useTama/tama-server
claude plugin install tama@usetama
```

Claude Code prompts for the server address and a device token, keeps the token
`sensitive` rather than in shell history, and adds a `/tama:save` command
beside the five tools. `clients/claude-code` is the plugin.

Mint the token with `tama token claude-code`.

### When the server is loopback-only

Both clients dial from your own machine, which is what lets them reach a
private address - and also means the server has to be reachable from there.
`tama expose` on the server is the answer: a stable HTTPS address on your
tailnet, no tunnel, every device including a phone.

Until that is set up, an SSH tunnel works and `scripts/tama-tunnel` keeps it
up:

```sh
scripts/tama-tunnel install ubuntu@YOUR_SERVER
scripts/tama-tunnel status
```

That is a stopgap and it is worth being clear why it exists. The problem is not
typing the ssh command; it is that a hand-run tunnel dies on reboot, on sleep,
on changing wifi - and when it does, every client reports a connection refused
and the vault reads as **empty rather than unreachable**. A note that is not
there looks the same as a note that was never written. So the fix has to
restart itself rather than rely on somebody noticing: launchd brings it back
about two seconds after it dies, measured by killing it.

### The desktop app

One file, two fields. `clients/claude-desktop` is an `.mcpb` bundle: Claude
Desktop's own one-click install format.

**On the server**, mint a token:

```sh
tama token claude-desktop
```

**On your computer**, download the bundle, double-click it, and fill in the two
fields Claude Desktop shows: the server address and that token.

```sh
curl -LO https://github.com/useTama/tama-server/releases/latest/download/tama.mcpb
```

That link always resolves to the current release, so it does not go stale. The
token field is `sensitive`, so it is masked and kept in the OS keychain rather
than a config file. Node is not a prerequisite - Claude Desktop ships its own.

### Why not a custom connector

Because a custom connector cannot reach this server. **A remote connector is
dialled from Anthropic's servers, not from your computer**, so a vault on a
tailnet, a LAN or `127.0.0.1` is unreachable from there whatever the URL says.
Making one work means a domain, TLS, and OAuth 2.1 with dynamic client
registration - all of it in order to put one person's notes on the public
internet.

An `.mcpb` runs locally over stdio, so it reaches whatever you can reach, and
`tama expose` is enough. This is also the answer to the note in
`docs/deploy-docker.md` that `tama expose` covers MCP: it does, for a client
running on a machine of yours. It never covers a remote connector.

The bundle owns no vault, no database and no logic - it forwards JSON-RPC to
the route below. Section 2's reason for not shipping a stdio server stands; the
bundle is a pipe to the daemon, not a second one.

## 5b. Connecting Claude Code, Cursor, or anything else over HTTP

The server binds `127.0.0.1:8080`, so a laptop needs a tunnel. **Run this on
the laptop, not on the server** - the server has no key to itself:

**On the server**, mint a token for this client:

```sh
tama token mcp-laptop
```

It prints once. `--as AUDIENCE` instead if you want it scoped to a view.

**On your Mac**, open the tunnel and leave it running:

```sh
ssh -N -L 8788:localhost:8080 ubuntu@YOUR_SERVER
```

The left number is yours to choose; only the right one has to be 8080. 8788
rather than 8080 so it cannot collide with a dev server you already run.

**On your Mac**, in another terminal:

```sh
claude mcp add --transport http tama http://localhost:8788/mcp \
  --header "Authorization: Bearer PASTE_THE_TOKEN"
claude mcp list
```

Then in any Claude Code session, ask something only your notes would know.

A tunnel that has to be up is friction, and it is the third feature waiting on
a domain: with HTTPS in front, this is a plain URL and no tunnel at all.

## 6. Testing it by hand

Worth doing once, because it demystifies the whole thing. Every MCP client is
doing exactly this:

```sh
TOKEN=your_device_token

# what can it do
curl -s -X POST localhost:8080/mcp \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' | jq

# what are the tools
curl -s -X POST localhost:8080/mcp \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | jq -r '.result.tools[].name'

# search the vault
curl -s -X POST localhost:8080/mcp \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"search_notes","arguments":{"query":"kiks studios brand"}}}' \
  | jq -r '.result.content[0].text'
```

## 7. Two conventions worth copying

**A tool failure is a result, not a protocol error.** When `read_note` cannot
find a note it returns `{content: [...], isError: true}` with a 200 and no
JSON-RPC error. The model then sees what went wrong and can try something else.
A JSON-RPC error is for a malformed call, and it is hidden from the model, so
using it for "that file does not exist" means the model never learns why its
call failed.

**A hidden note reads as absent.** `read_note` on a note outside the caller's
view says `No note at X`, the same as a note that does not exist. Saying
"forbidden" would confirm the note exists, which is the same disclosure as
showing its path.

## 8. Adding a tool

One entry in the `TOOLS` array in `src/mcp.ts`:

```ts
{
  name: "snake_case_name",
  title: "Short human label",
  description: "When to call this, in the model's terms. Say what it is not.",
  inputSchema: { type: "object", properties: { ... }, required: ["..."] },
  async run(args, caller, deps) {
    if (!caller.mayWrite) return { text: "...", isError: true };  // if it writes
    return { text: "what happened" };
  },
}
```

Three rules that come from how the existing five behave:

1. **Wrap something tested.** If the capability does not exist as a route or a
   module function yet, build it there first. A tool is the wrong place for
   logic, because the tests that matter are the ones on the thing underneath.
2. **Honour `caller.view` and `caller.mayWrite`.** Every read filters by view,
   every write checks `mayWrite`. Forgetting either is how a scoped token
   quietly becomes an unscoped one.
3. **Write the description last and rewrite it twice.** It is the interface.

## 9. What is deliberately missing

- **Resources and prompts.** Both are MCP features; neither earns its place
  yet. Tools cover reading and writing, and resources would be a second way to
  express `read_note`.
- **Streaming.** No tool here produces output slowly enough to need it.
- **Batching.** Removed from the spec, and a batch of vault writes is not a
  thing to encourage.
- **The official SDK.** Three methods hand-rolled keeps tama dependency-free,
  the same trade `llm.ts` makes by talking to providers over plain fetch. If
  this ever grows resources, prompts or sampling, use the SDK instead.
