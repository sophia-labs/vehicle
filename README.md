# Vehicle

Vehicle is how people and agents talk to a [Sophia](https://github.com/sophia-labs/gardend) agent, through one
surface. A person in the chat panel, a person in a terminal, a person in Neovim and another agent all speak the
same **ride protocol**. They share the same rules: one driver at a time, attributed chimes from everyone else, and
sessions that outlive any process.

This is the canonical repository for Vehicle; see [CONTRIBUTING.md](CONTRIBUTING.md) to build and test it.

This repository holds:

| path | what |
|---|---|
| `src/` | the `vehicle` command (Rust, `ratatui`): the terminal **room**, **chimes**, the JSONL **ride** for agents, and the Garden document bridge |
| `ts/packages/vehicle-host` | **vehicle-host**, the Node service that holds the sessions and serves the ride protocol |
| `ts/packages/pi-sophia` | **pi-sophia**, Sophia's behaviour as one [pi](https://github.com/earendil-works/pi) extension: the graph's tools over MCP, the workspace prompt, tool profiles, a budget guard |
| `lua/`, `plugin/` | **vehicle.nvim**, a standalone Neovim plugin that edits Garden documents by block id |
| `protocol/` | the ride protocol v2 ([`ride-v2.md`](protocol/ride-v2.md)) and its JSON schemas |
| `tests/`, `fixtures/` | tests against a real vehicle-host and a demo document |

## What Vehicle is

**One surface for people and agents.** Every client speaks ride protocol v2 (`sophia.vehicle-ride.v2`). Over
HTTP it is a few routes: create a session, claim it, send commands, chime, and watch its events (server-sent
events, or long-poll from a cursor). Over stdio it is JSONL (`vehicle ride`). The verbs are the same either way:
`claim`, `release`, `prompt`, `follow_up`, `steer`, `abort`, `cancel`, `fork`, `clone`, `chime`, `inspect`,
`capsule`, `watch`, `shutdown`. `requestId` is the idempotency key, so a retried request never runs twice.

**The driver lease.** A session has one driver at a time. Every mutation (a prompt, a steer, an abort, a policy
change) needs the lease, which is bound to a person and to one client of theirs (a browser tab, a terminal, an
agent process). The same person in another tab can take the wheel over (`claim` with `takeover`); another person
never can. A second client without the lease reads and watches but cannot drive. Leases expire when unused and
survive a host restart.

**Chimes.** Anyone authenticated on a session's graph, person or agent, can send a chime: an attributed message
into someone else's room. The room's policy decides what happens to it:

| policy | a chime |
|---|---|
| `observe`, `mute` | is refused, with the room's reason |
| `suggest` (the default) | waits until the driver accepts or rejects it |
| `co-drive` | goes in at once, under the driver's lease |

An accepted chime reaches the model as `[<author> collaborator]`. A collaborator is always named and never
impersonates the driver.

**Sessions that persist, branch and are mirrored into Garden.** A session is a pi session file plus an
append-only command log and event log. The process that runs it (its *body*) is mortal: it is put away when idle
or when the host stops, and revived from pi's file at the next command. A session can be **forked** (a new
conversation from before any message, with that message ready to edit and resend) or **cloned** (a copy of the
whole conversation). Each branch is its own conversation and remembers where it came from. After every settled
run, the session's record is written to a document in its graph (`_sophia/Conversations/<title>`), as the
person, through gardend. A conversation can then be read, searched and linked like any other document, and a
branch's document links its parent's.

### Principles

The code refers to these by number.

1. **The body is a pi session**, upstream and pinned exactly, never forked. Sophia's behaviour is one extension
   (`pi-sophia`).
2. **Continuity lives in memory, never in a process.** gardend holds the graph, the memory and the record of every
   session. Bodies can always be made again.
3. **Bodies die by default and can be revived** from their session file, which can also be forked and cloned.
4. **Backtracking is first-class wherever there is state:** the conversation (fork, clone), the memory (Garden's
   restore points), and the machine (a microVM snapshot, where one exists).
5. **One surface for people and agents.** The ride protocol is the only way in.
6. **One driver at a time; everyone else chimes.** Nobody impersonates the driver.
7. **Isolation is a setting, not an architecture** (see [Isolation](#isolation)).
8. **Self-host first.** It runs on macOS, Linux and inside WSL2, and each person brings their own model key.

## How it runs

```
clients: Sophia's chat panel · vehicle room · vehicle.nvim · other agents (vehicle ride)
   │  ride protocol v2: HTTP + SSE or long-poll; JSONL over stdio
gardend: auth, identity, supervision, /services/vehicle, the graph and its memory over MCP
   │
vehicle-host (Node 22.19+): sessions, the lease, command and event logs, watch cursors, capsules, chimes
   │  pi's SDK in process (chat), or `pi --mode rpc` in a box (agent)
pi + pi-sophia: gardend's graph tools, Sophia's prompt, the budget guard, the session mirror
```

### Under gardend

[gardend](https://github.com/sophia-labs/gardend) supervises vehicle-host as its local service `vehicle`. It
starts `services/vehicle/service.json` beside its binary (or under `GARDEN_SERVICES_DIR`) and mounts it at
`/services/vehicle`. gardend authenticates every caller (the profile's key, a member token, or a Cloudflare Access
login), drops whatever identity headers the caller sent, and forwards with the ones it mints itself: who calls,
their role, and, on a graph path (`/services/vehicle/g/<graph>/...`), the graph. vehicle-host believes nothing
else. Each session's tools reach gardend's `/mcp` as the person, with a short-lived token gardend hands over for
that person and graph. The model never chooses the graph.

gardend archives that include chat carry the service as `services/vehicle/`. To build it from this repository:

```bash
cd ts
scripts/package-service.sh <gardend dir>/services/vehicle   # one bundled file (esbuild), about 10 MB
node scripts/test-bundle.mjs <gardend dir>/services/vehicle  # vehicle-host's tests against that bundle
gardend chat key set < key.txt                              # the model key (an OpenRouter key), kept by gardend
```

gardend checks for Node.js 22.19 or newer on its PATH before it starts the service. Without it, chat says so.

### Standalone

vehicle-host is a plain Node service. It trusts only the identity a front mints, as described in
[`protocol/ride-v2.md`](protocol/ride-v2.md) ("Trust"). gardend is that front; any authenticating proxy that does
the same will do. It reads `PORT`, `DATA_DIR`, `MNEMOSYNE_INTERNAL_SERVICE_SECRET` (the secret the front sends as
`x-internal-service`) and, for graph tools, `MNEMOSYNE_MCP_URL` (gardend's loopback `/mcp`).
`ts/packages/vehicle-host/src/main.ts` lists the rest.

To try the room without gardend and without a model key, run the host with pi's faux model behind a
gardend-shaped front:

```bash
cd ts && pnpm install
VEHICLE_FAUX_FRONT_TOKENS='{"try-me":{"principal":"alice","role":"owner"}}' \
  node --conditions=sophia-source packages/vehicle-host/test/faux-service.ts
# prints {"host":"http://127.0.0.1:…","front":"http://127.0.0.1:<port>"}

VEHICLE_TOKEN=try-me vehicle room --gardend http://127.0.0.1:<port> --graph demo --new
```

The faux model answers `faux heard: <your message>`, and it has no graph tools.

## The `vehicle` command

```bash
cargo install --locked --git https://github.com/sophia-labs/vehicle   # Rust 1.88 or newer
```

On Linux the build needs OpenSSL's headers and `pkg-config` (`sudo apt install libssl-dev pkg-config`).

```bash
vehicle room --new --graph <graph>                 # a new session on a graph, in its room
vehicle room --new --graph <graph> --profile agent # an agent: an isolated body with a working folder and a shell
vehicle room                                       # pick one of your sessions (the lobby)
vehicle room <session-id>                          # enter a session's room
vehicle sessions [--graph <graph>] [--json]        # list your sessions
vehicle branch <session-id> [--before <N|id>]      # a new conversation from before message N (default: the last)
vehicle duplicate <session-id>                     # a new conversation with the whole history ("Copy of …")
vehicle chime <session-id> "look at the charger first" [--author Codex] [--delivery prompt|follow-up|steer]
vehicle policy <session-id> observe|suggest|co-drive|mute
vehicle ride --new --graph <graph>                 # JSONL over stdio, for agents
```

Every ride command takes:

| flag | default | what |
|---|---|---|
| `--gardend <url>` | `$VEHICLE_GARDEND`, else `http://127.0.0.1:7674` | the gardend to go through |
| `--graph <id>` | `$VEHICLE_GRAPH` | the graph to bind. A new session needs one. A room or ride opened by session id binds its session's graph itself |
| `--key-file <path>` | `$VEHICLE_KEY_FILE`, else `~/sophia/selfhost-key.json` | the gardend profile's key (`{"key": ...}`) |
| `--token-env <NAME>` | `VEHICLE_TOKEN` | a variable holding a gardend token (`gardend token create --grant member`), used instead of the key when set |
| `--client-id <id>` | `$VEHICLE_CLIENT_ID`, else one per process | the client that holds the driver lease |

A key or token is sent only as `Authorization: Bearer …` to gardend. It is never printed, logged or put in a URL.

### `vehicle room`

The room reads the session and follows its events. The reply streams over server-sent events. It falls back
to long-poll when the way in cannot stream (`--watch poll` forces it). A dropped stream resumes from its cursor,
with no gap and no repeat.

- **One driver.** The room claims the lease when nobody holds it. Otherwise it is read-only and says who drives.
  `/claim` takes the lease once it is free, and `/take` takes it over from another of your own clients. Leaving
  (Ctrl-C, `/quit`, the terminal closing) releases it.
- **The composer.** Enter sends a `prompt`. While a run is going, Enter sends a `steer` instead, which pi
  delivers before its next model call. `/follow-up TEXT` queues a follow-up, Esc (or `/abort`) stops the run,
  `/cancel ID` takes a queued command back, and Ctrl-J adds a newline.
- **Chimes.** The header shows the policy and how many chimes wait. `/accept [ID]` and `/reject [ID]` take the
  oldest first, and `/policy observe|suggest|co-drive|mute` changes the policy.
- **Branches.** Messages are numbered (`you · #2`). `/branch [N]` moves the room to a new conversation from before
  message N, with N's words in the composer to edit and send. `/duplicate` copies the whole conversation.
- **Panes** (Tab): activity, chimes, session (model, lease, budget, cost, tools), commands, debug. `/rename`,
  `/new [TITLE]`, `/help`.

### `vehicle ride`: JSONL for agents

`vehicle ride` is the ride over stdio. It writes `ready` first, then one frame per request line, and `closed`
last (on `shutdown`, or at the end of input, when it also gives the lease back).

```text
$ vehicle ride --new --graph <graph> --client-id agent-7
→ {"protocol":"sophia.vehicle-ride.v2","type":"ready","clientId":"agent-7","claimed":true,"cursor":2,"session":{...}}
← {"op":"prompt","requestId":"r1","text":"Which part converts the battery voltage to 3.3 V?"}
→ {"protocol":"sophia.vehicle-ride.v2","type":"command.accepted","requestId":"r1","value":{...}}
← {"op":"watch","requestId":"w1","waitMs":30000}
→ {"protocol":"sophia.vehicle-ride.v2","type":"watch.completed","requestId":"w1","value":{"events":[...],"cursor":17}}
← {"op":"shutdown","requestId":"s1"}
→ {"protocol":"sophia.vehicle-ride.v2","type":"closed","requestId":"s1","value":{...}}
```

The ops are `claim`, `release`, `prompt`, `follow_up`, `steer`, `abort`, `cancel`, `fork`, `clone`,
`set_room_policy`, `accept_chime`, `reject_chime`, `rename`, `delete`, `shutdown`, `chime`, `inspect`, `capsule`
and `watch` (`since`, by default the ride's cursor, and `waitMs` up to 30 000). Their bodies are the HTTP bodies in
[`protocol/ride-v2.md`](protocol/ride-v2.md). A refusal is an `error` frame with the host's `code` (`lease_held`
names the holder) and the request's `requestId`. `--session <id>` rides an existing session, and `--no-claim`
watches and chimes without driving.

### Talking to a public Sophia

A gardend in public mode lets people and agents with no login of its own read its public graphs and talk to an
agent about them. An agent needs only the URL:

```bash
export VEHICLE_MODEL_KEY=…        # your own OpenRouter key: https://openrouter.ai/keys
vehicle ride --gardend https://cow-tools.sophia-labs.com --graph uruguay-cows --new
```

With no token and no `--key-file`, a gardend that is not on this computer is ridden as a visitor (`--anonymous`
forces it). The visitor keeps one id (`~/.local/state/vehicle/visitor-id`, or `--visitor-id`), so its sessions
can be found again later with `--session <id>`. The model key is read from the environment, from
`VEHICLE_MODEL_KEY` or the variable `--model-key-env <NAME>` names, never from the command line. It goes with
every request as `X-Model-Key`, and the host keeps it in memory only. A Sophia account's ID token goes in
`VEHICLE_TOKEN` instead, and then the conversation runs on the account's credit. A public conversation reads
every public graph, and its turns and spend are capped. The protocol's "Public sessions" section has the details.

## Isolation

A session's `profile` is fixed when it is made.

- **`chat`** (the default): pi runs inside vehicle-host's own process, with the graph's tools only. Its tools
  touch nothing but the graph, through gardend, as the person.
- **`agent`** (the graph's owner only): the graph's tools plus pi's `read`, `write`, `edit` and `bash` on the
  session's own working folder. Its body is `pi --mode rpc` in a child process, inside a box:

| `VEHICLE_ISOLATION` | where | the box |
|---|---|---|
| `bwrap` | Linux, WSL2 (`sudo apt install bubblewrap`) | a read-only system, a private `/tmp`, no home folder, only the session's workspace and pi folder writable, every other session out of sight, a cleared environment, all namespaces unshared but the network, no capabilities even as root, the box dies with its parent |
| `seatbelt` | macOS (`sandbox-exec`, built in) | a generated deny-by-default profile: writes only in the session's folders and a private temporary folder, no reads of the home folder or the data dir, no Launch Services, Apple Events or launchd |
| `none` | anywhere | no box: agent sessions are refused unless the operator also sets `VEHICLE_AGENT_UNISOLATED=1` |
| `microvm` | where KVM exists | not implemented yet: agent sessions are refused with that reason |

The default follows the platform, and the host checks its box once at start with a real body. A host that cannot
isolate refuses agent sessions with the reason. The model key reaches a body once, over a pipe that is closed
before any tool runs: never through its environment, its arguments or a file. The graph token is asked for over
pi's own RPC channel before every graph request, and never touches a disk.

## vehicle.nvim

A Neovim plugin that edits Garden documents by block id: each line carries its block's identity as an extmark, so
moving lines never writes text into the wrong block. It works on its own, without the rest of Vehicle.

```lua
vim.opt.rtp:append("/path/to/vehicle")
require("vehicle.garden").setup({
  adapter = { kind = "json-file", root = "/path/to/vehicle/fixtures/garden-docs" },
})
```

```vim
:VehicleGardenOpen demo-doc
:write
```

The adapters:

| `adapter.kind` | what it edits |
|---|---|
| `json-file` | a JSON document of blocks |
| `bridge-json`, `bridge-ydoc-file` | the same through the `vehicle bridge` command; a Garden Y.Doc file (`update-v1.bin`) |
| `live-ydoc-file` | a Y.Doc file through a long-running `vehicle bridge live` process |
| `bridge-ydoc-room`, `live-ydoc-room` | a Garden document's live websocket room (`url`, with `{document_id}`; a token from `token_env`) |

Bridge adapters take `bridge = "/path/to/vehicle"` (the binary). Live adapters stream edits after a short debounce
(`stream_changes`, `stream_debounce_ms`). `live-ydoc-room` also shows collaborators' carets and publishes yours
(`presence = { name = "…", color = "#7aa2f7" }`, or `presence = false`).

Garden structure is drawn without changing the buffer's text: headings, quotes, lists and code blocks. `>>`, `<<`,
Tab and S-Tab indent blocks structurally. Enter, `o`/`O`, Backspace at column zero and `J` split, insert and join
blocks. `:VehicleGardenTree` opens an outline with comments and footnotes. Comments and footnotes are Garden's own:
`:VehicleGardenComment`, `:VehicleGardenComments`, `:VehicleGardenCommentEdit`, `:VehicleGardenCommentResolve[!]`,
`:VehicleGardenCommentDelete`, `:VehicleGardenFootnote`, `:VehicleGardenFootnotes`, `:VehicleGardenFootnoteEdit`,
`:VehicleGardenFootnoteDelete`. `:VehicleGardenSync`, `:VehicleGardenStatus` and `:VehicleGardenBridgeStop` do
what they say.

The bridge is also a command of its own (`vehicle bridge project-json | save-json | init-ydoc | project-ydoc |
apply-ydoc | sync-ydoc-once | live`). It reads and writes Garden Y.Docs with [`yrs`](https://github.com/y-crdt/y-crdt),
mutating the document in place so that comments and other state survive. Offsets are UTF-16, as in Garden's block
operations. `cargo run -- garden-fixture` seeds a local Garden-shaped profile, opens a small browser view of it and
starts Neovim on it.

## Development

```bash
cargo test                   # unit tests, then tests against a real vehicle-host (pi's faux model)
cd ts && pnpm install && pnpm test
```

The Rust tests that need vehicle-host spawn `ts/packages/vehicle-host/test/faux-service.ts`: the real host with
pi's faux provider (a scripted model, so no key and no cost) behind a gardend-shaped front. They cover the
client, the CLI, the JSONL ride, streams cut mid-run, and the room itself in a real pseudo-terminal. They need
Node.js 22.19+ and `pnpm install` in `ts/`. Without them they print SKIPPED, and
`VEHICLE_REQUIRE_HOST_TESTS=1` makes them fail instead.

A real gardend adds the legs through it, each on a throwaway profile and a free port:
`VEHICLE_TEST_GARDEND=<gardend binary> cargo test` and `VEHICLE_TEST_GARDEND_BIN=<gardend binary> pnpm test`.
`ts/scripts/ride-smoke.mjs` runs one ride turn on a packaged service.

## Licence

MIT ([`LICENSE`](LICENSE)). pi (`@earendil-works/pi-*`) is MIT too; its licence is kept in
[`ts/licenses/pi-LICENSE`](ts/licenses/pi-LICENSE). The bundled service carries `THIRD-PARTY-NOTICES.md`: every
package bundled into it, with its licence text.
