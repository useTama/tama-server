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

The server binds `127.0.0.1:8080`, so a laptop needs a tunnel. **Run this on
the laptop, not on the server** - the server has no key to itself:

```sh
# on your Mac
ssh -N -L 8080:localhost:8080 ubuntu@YOUR_SERVER
```

Leave it running, then in another terminal:

```sh
claude mcp add --transport http tama http://localhost:8080/mcp \
  --header "Authorization: Bearer $TOKEN"
```

`$TOKEN` is a device token from `tama settings` (Devices, or an audience's
token for a scoped one). Check it took:

```sh
claude mcp list
```

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
