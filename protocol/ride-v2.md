# Vehicle ride protocol v2 (`sophia.vehicle-ride.v2`)

Status: 2026-10-13 (sessions under gardend; rename, delete, the same person's takeover, the transcript's times);
public sessions 2026-10-14. Implemented by `ts/packages/vehicle-host`; the design's principles are in the README.
JSON schemas: `protocol/schemas/`.

v2 keeps v1's verbs and their meaning (`claim`, `release`, `prompt`, `follow_up`, `steer`, `abort`, `cancel`,
`inspect`, `capsule`, `watch`, `shutdown`) and adds `fork`, `clone`, `chime`, `rename` and `delete`, and a
`takeover` flag on `claim`. What changed is underneath:
a session is a [pi](https://github.com/earendil-works/pi) session (pinned, never forked) with the
`@sophia-labs/pi-sophia` extension, held by `vehicle-host`.

## Trust

`vehicle-host` is a local service gardend supervises (`services/vehicle/service.json`, mounted at
`/services/vehicle`; gardend's
[`docs/local-service-hosting.md`](https://github.com/sophia-labs/gardend/blob/main/docs/local-service-hosting.md)). It binds loopback only (`GARDEN_SERVICE_HOST`) and
gardend is the way in: gardend authenticates the caller (the master key, a client token, a Cloudflare Access login),
drops every identity header the caller sent (`authorization`, `cookie`, `x-user-*`, `x-graph-*`, `x-sophia-*`,
`x-internal-*`, ...), and forwards with the set it mints:

| header | meaning |
|---|---|
| `x-internal-service` | gardend's per-spawn secret (`MNEMOSYNE_INTERNAL_SERVICE_SECRET`); every route but `/health` requires it |
| `x-user-id` | who calls: `owner` (master key), `token:<id>`, an Access email, `service:<id>` |
| `x-sophia-caller-role` | the caller's role from its grant: `owner`, `editor` or `viewer` |
| `x-graph-id`, `x-sophia-graph-role` | on a graph-scoped path (`/services/vehicle/g/<graph>/...`, which gardend strips to `/...`): the graph and the caller's role on it |
| `x-sophia-delegated-token` | with the graph (the manifest says `"delegateCaller": true`): a token for gardend's `/mcp` that acts for this caller, on this graph, with this role, for an hour |
| `x-vehicle-client-id` | the caller's own: one client instance (a chat tab, a terminal, an agent), the unit that holds the lease. Defaults to the principal. No authority: the lease binds the principal too |
| `x-sophia-caller-kind` | public mode only: `anonymous` (a visitor, `anon:<hash>`) or `account` (a Sophia account, `cognito:<sub>`); always a viewer (see "Public sessions") |
| `x-sophia-account-email`, `x-sophia-account-email-verified` | an account's email and whether its ID token says it is verified |
| `x-sophia-public-graphs` | public mode only: every public graph, a comma list (a public conversation reads them all) |
| `x-model-key` | the caller's own model key (an OpenRouter key), passed by gardend only because the manifest says `"acceptsModelKey": true`; memory only (see "Public sessions") |

Identity headers are believed only with the secret. **The graph comes only from `x-graph-id`**: a session is created
on the graph of the path it was created through (`POST /g/<graph>/sessions`), a body that names another graph is
refused (`graph_mismatch`), and a request bound to one graph never sees a session of another. With a graph, the role
is `x-sophia-graph-role`; without, `x-sophia-caller-role`. A session belongs to the principal who created it: only
they read it, drive it, rename it or delete it (to anyone else it does not exist: `not_found`, never a hint that it
does); anyone authenticated on its graph may `chime`. The role at creation fixes the session's
access for its life: `viewer` gets the reader tools, `owner`/`editor` the writer tools; a caller whose role has since
dropped to `viewer` may read a writer's session but not drive it (`access_reduced`); it may still rename or
delete it, since those change the person's own record and not the workspace.

The body's graph tools reach gardend's loopback `/mcp` (`MNEMOSYNE_MCP_URL`) as the session's owner: with the newest
delegation token gardend handed with that owner's requests on the session's graph (gardend's
[`docs/local-service-hosting.md`](https://github.com/sophia-labs/gardend/blob/main/docs/local-service-hosting.md),
"Delegation tokens"), read before every MCP request. gardend binds the graph through
it: `tools/list` has no graph argument, every call gets the session's graph, a call naming another graph is refused,
a viewer's token cannot write, and the writes are the person's in gardend's audit log (`actor`, `via:
service:vehicle`). The host keeps the token in memory only (never in a file, an event, the capsule or a listing). A
revived session has none until its owner's next request, and a command that would start a body without one is
refused (`delegation_required`, 409). The process's own token (`MNEMOSYNE_MCP_ACCESS_TOKEN`) is not used: the host
drops it from its environment at start.

## Profiles and bodies

A session's `profile` is fixed at creation.

- **`chat`** (the default): pi in the host's process, with the graph tools only; pi's built-ins are never active.
- **`agent`**: the graph tools plus pi's `read`, `write`, `edit` and `bash` on the session's own working folder
  (`$VEHICLE_DATA_DIR/workspaces/<sessionId>/`). Its body is a `pi --mode rpc` child inside a box of the host's
  isolation tier (`VEHICLE_ISOLATION`: `bwrap` on Linux and WSL2, `seatbelt` on macOS; `microvm` is refused as not
  implemented; `none` is refused unless the operator sets `VEHICLE_AGENT_UNISOLATED=1`). Only a caller whose role
  on the graph is `owner` may create one (`forbidden_profile`, 403) or drive one (`access_reduced`, 403, once the
  role has dropped); a host that cannot make the box refuses it with the reason (`isolation_unavailable`, 503).
  The summary, the listing and the capsule carry `profile` and, for an agent, `isolation`.

The verbs, events, lease, chimes, capsule and revival are the same for both bodies. An agent body's own folders are
the only places it may write: its workspace, its pi folder (pi writes its conversation there) and a private
temporary folder; the rest of the system is read-only, and the home folder, the data dir (every other session) and
the gardend profile are out of sight. The model key reaches the body once, over a pipe closed before any tool runs
(never its environment, arguments or a file); the delegation token is asked for over pi's RPC channel before every
MCP request (an extension-UI `input` titled `sophia.delegated-token`), so it is the newest one and never touches a
disk. A body that dies by itself is reported (`body.exited`), its run settles as aborted (`stopReason:
"body_exited"`), its open commands fail, and the next command materializes a new body from pi's file. A fork or
clone of an agent session copies its workspace (a snapshot; links copied as links, never followed).

## Routes

| route | verb |
|---|---|
| `POST /sessions` | create on the bound graph (body: `requestId`, optional `profile` = `chat` (default) or `agent`, `model` = `provider/model`, `title`, `budget`, `claim` default true; `graphId` only if it repeats the bound graph) |
| `GET /sessions` | the caller's sessions on the bound graph (every graph when unbound), most recently active first, each with `updatedAt` and a `preview` of the first thing said |
| `GET /sessions/:id` | `inspect`: summary, commands, queue, pending chimes, transcript (active branch, each item with pi's `timestamp`), tools, stats |
| `PATCH /sessions/:id` | `rename` (`title`, a string or null; optional `requestId`) |
| `DELETE /sessions/:id` | `delete`: the record moves to the host's `trash/` |
| `POST /sessions/:id/claim` | `claim` (`requestId`, optional `ttlMs`, default 30 min, optional `takeover`) |
| `POST /sessions/:id/release` | `release` (`requestId`) |
| `POST /sessions/:id/commands` | `prompt`, `follow_up`, `steer`, `abort`, `cancel`, `shutdown`, `fork`, `clone`, `set_room_policy`, `accept_chime`, `reject_chime` |
| `POST /sessions/:id/chimes` | `chime` (`requestId`, `author`, `delivery`, `text`) |
| `GET /sessions/:id/events?since=&waitMs=` | `watch`: long-poll, or SSE with `Accept: text/event-stream` |
| `GET /sessions/:id/capsule` | `capsule` |
| `GET /account` | the caller's limits and, for a Sophia account, its credit; for a visitor, the doors (see "Public sessions") |
| `POST /account/grants` | the owner only: credit for an account (`principal`, `amountUsd`, `source` = `purchase` or `operator`, `idempotencyKey`, optional `note`); idempotent by its key |
| `GET /health` | liveness, no auth |

## Frames

Every response is one frame, as v1's stdio frames:

```json
{"protocol":"sophia.vehicle-ride.v2","type":"command.accepted","requestId":"req-1","value":{...}}
{"protocol":"sophia.vehicle-ride.v2","type":"error","code":"lease_held","message":"...","details":{"holder":{...}}}
```

A replayed request carries `"replayed": true` beside the original frame. Types: `session.created`,
`session.list`, `session.snapshot`, `session.renamed`, `session.deleted`, `driver.claimed`, `driver.released`,
`command.accepted`, `command.cancelled`, `session.forked`, `session.cloned`, `room.policy`, `chime.accepted`,
`chime.rejected`, `closed`, `watch.completed`, `session.capsule`, `error`.

| error code | HTTP | when |
|---|---|---|
| `unauthorized` | 401 | the secret is missing or wrong |
| `identity_required`, `invalid_identity` | 401, 400 | identity headers missing or malformed |
| `graph_required`, `graph_mismatch` | 400 | `POST /sessions` on a path that names no graph, or a body naming another graph |
| `access_reduced` | 403 | the caller's role now only reads; the session writes (or: an agent session, and the caller is no longer the graph's owner) |
| `forbidden_profile` | 403 | `profile: "agent"` from a caller who is not the graph's owner |
| `isolation_unavailable` | 503 | this host cannot isolate an agent body (the setting, or a probe of the box); `message` says why |
| `body_tampered` | 409 | an agent's workspace or pi folder is no longer the folder the host made (a link in its place) |
| `invalid_request`, `invalid_json`, `body_too_large` | 400, 400, 413 | the body |
| `not_found` | 404 | no such session, or it is not the caller's |
| `not_session_owner` | 403 | another principal tried to drive or fork |
| `lease_required` | 409 | nobody holds the lease |
| `lease_held` | 409 | another client holds it; `details.holder` names it, `details.canTakeOver` says whether this caller may take it over (the same principal) |
| `lease_not_held` | 409 | `release` by a non-holder |
| `request_id_conflict` | 409 | a `requestId` reused with a different body |
| `command_exists`, `not_cancellable`, `chime_not_pending`, `nothing_to_fork` | 409 | state conflicts |
| `session_running` | 409 | `delete` while a run or an unsettled command is under way; `details.open` lists the commands |
| `model_unavailable` | 400/503 | the model is not on this host |
| `model_key_required` | 402 | a visitor with no key and no account (`details.doors`), or a conversation on the caller's own key whose request did not bring it |
| `out_of_credit` | 402 | "out of credit: paste your OpenRouter key (send it as X-Model-Key) to keep talking" |
| `email_unverified` | 402 | an account whose email is not verified has no credit yet |
| `credit_pool_exhausted` | 503 | today's credit-funded spend (everyone together) reached its cap |
| `daily_turn_limit`, `session_turn_limit` | 429 | a public caller's turns today, or this conversation's turns |
| `model_not_allowed` | 400 | a credit conversation's model is not on the credit list, or an own key names another provider's model |
| `invalid_model_key` | 400 | `x-model-key` is not one printable token of 8 to 512 characters |
| `chimes_closed` | 403 | a chime into a public conversation |
| `not_public`, `forbidden` | 403 | public sessions are off on this host; `POST /account/grants` by anyone but the owner |

## The lease

One driver at a time. The creating client holds the lease unless it passed `claim: false`. Every mutation
(`prompt`, `follow_up`, `steer`, `abort`, `cancel`, `shutdown`, `set_room_policy`, `accept_chime`, `reject_chime`)
requires the exact lease: same principal and same client id. A lease expires after `ttlMs` without use and is
renewed by use; it survives a host restart (it is rebuilt from the event log). `fork` and `clone` need only
ownership: they do not touch the source, and the new session's lease goes to the calling client.

**Takeover.** The same person in another tab, browser or terminal is another client: `claim` is `lease_held` for it
(with `details.canTakeOver: true`). `claim` with `takeover: true` succeeds only when the holder's principal is the
caller's: the holder's lease is revoked (`lease.revoked` with its `clientId`, `by` and `reason: "takeover"`, then
`lease.claimed` for the caller), and the frame names whom it took over from (`value.tookOverFrom`). The old holder
sees `lease.revoked` on its watch, and its next mutation is `lease_held` (it may take the lease back the same way).
A run under way goes on (it is the same person's; the new holder may steer or abort it). Another principal's lease
is never taken over: `lease_held` with `canTakeOver: false`, whatever `takeover` says. One driver at a time, and
nobody impersonates the driver. `takeover: false` is the same request as no flag.

## Rename and delete

Both are the owner's, like reading (another principal, or the owner through another graph, gets `not_found`), and
neither needs the lease: they change the person's own record, not the conversation.

- **`PATCH /sessions/:id {title}`:** whitespace runs become one space, then trimmed; at most 200 characters. `null`
  or an empty string clears the name (the list then shows the preview). The title is kept in `meta.json` (rewritten
  whole) and announced as `session.renamed`; `GET /sessions` and `inspect` return it. Answer: `session.renamed` with
  the summary.
- **`DELETE /sessions/:id`:** refused with `session_running` (409) while a run is under way or a command is still
  open: abort first. Deleting never cuts off a reply another of the person's clients is showing. Otherwise the body
  is disposed and the session's whole directory is moved, never unlinked, to `trash/<sessionId>/` under the host's
  data dir (a suffix if that name is taken), with a `deleted.json` naming the session, the time and the client.
  `session.deleted` (`trashedAs`) is the last event, written into the moved log: it ends every SSE watch and wakes
  every long-poll. Afterwards the session is not listed, every route for it is `not_found` (a repeated `DELETE`
  too), and a restart does not revive it. Answer: `session.deleted` with `sessionId`, `trashedAs` and, when the
  session was mirrored, `mirror: {documentId, graphId}`: the client puts that document in the workspace's Trash
  with the person's own credential (gardend `DELETE /navigation/<graph>/documents/<id>`; the delegation token
  reaches only `/mcp`, where no tool trashes a document). To restore: stop the service, move the directory back
  to `sessions/<sessionId>/`, start it, and restore the document from the workspace's Trash (`deleted.json` says
  so).

## The mirror

After each settled run (and after a rename) the session's record is written to a Garden document in its graph,
for the person: with the session's delegation token, through gardend's MCP tools, so gardend's audit names the
person `via: service:vehicle`. `VEHICLE_MIRROR=off` turns it off; a viewer's session never writes (its
`inspect` says so).

- **Where:** the graph's agent folder `_sophia` (folder id `agent-scratchpad`), in `Conversations` (folder id
  `sophia-conversations`), each made only when missing. One document per session, id
  `sophia-conversation-<sessionId>`, titled by the session's title, else its first question.
- **What:** a header (the model, the start), then each turn with who and when (UTC), the person's words as they
  wrote them (never pi-sophia's note about what was open), the replies' text and their tool calls as one-line
  chips; no tokens. A branch's header links its parent's document (a wikilink: "Branched from …" before the
  message it was forked at, or "Duplicated from …"), and the branch's document carries a wire `divergesFrom`
  to its parent's.
- **How:** `create_document` once (the folders before it, when missing), then `write_document` in place,
  skipped when nothing changed; a title change alone is `rename`. Events `mirror.written {documentId, created}`
  and `mirror.failed {documentId, message}`; a failed write is tried again at the next settle. A document the
  person put in the Trash stays there and is kept current.
- **State:** `mirror.json` beside the session; `inspect` returns `mirror: {state: off | skipped | pending |
  written | failed, documentId, folder, reason, writtenAt, error}`.

## Commands and pi

| ride op | pi, while idle | pi, while a run is active |
|---|---|---|
| `prompt` | `prompt()`: starts a run | `prompt(..., {streamingBehavior: "followUp"})`: queued as a follow-up |
| `follow_up` | `prompt()`: starts a run | `followUp()`: delivered when the run has no more tool calls or steering |
| `steer` | `prompt()`: starts a run | `steer()`: delivered after the current assistant turn and its tool calls, before the next model request |
| `abort` | nothing to stop | `clearQueue()` then `abort()` (pi's interactive Esc): the run stops, queued commands are `cancelled` |
| `cancel` | — | takes one queued command back out of pi's queue (`clearQueue()`, then re-queue the rest in order) |
| `shutdown` | dispose the body | abort, then dispose; the lease is released; the session stays revivable |
| `fork` | pi's `/fork`: a new session from before user message `entryId` (`SessionManager.createBranchedSession`); returns `selectedText`, that message as the person wrote it | same |
| `clone` | pi's `/clone`: a new session with the active branch | same |

A branch is its own conversation: its summary carries `parent {sessionId, kind, entryId}`; it is not named as its
source (a clone is "Copy of" its source's name; a fork is listed by its own first message, and before anything is
said in it by the first message of the history it begins with); it starts with its source's delegation token (the
same person on the same graph). A fork before the first message has no history: it starts empty, as a new
session does, and `selectedText` hands back the message to send again.

Text commands take `text` (at most 64 KiB) and optional `contextRefs` (ids of what the person has open; rendered
to the model as one note, ids only). `commandId` defaults to `requestId`. A command's status moves
`accepted → queued → delivered → completed | aborted | failed`, or ends `cancelled` or `interrupted` (its body
died with the host). `disposition` is pi's: `started`, `queued` or `handled`.

**Idempotency.** `requestId` is the key, per session (per principal for `POST /sessions`). A repeated request
with the same body returns the original frame with `replayed: true` and does nothing; the same `requestId` with
a different body is `request_id_conflict`. Refused requests (lease, validation) are not remembered, so a retry
after claiming succeeds. Accepted requests are kept in `commands.jsonl` and survive restarts.

## Inspect

`GET /sessions/:id` answers `session.snapshot` (`schemas/snapshot.schema.json`): the summary, the commands, pi's
queue, the pending chimes, the stats and tools of a live body, and the transcript of the active branch read from
pi (the live body, or pi's file when the body is dormant). Each transcript item carries `entryId` (pi's entry id,
what `fork` takes), `role`, `text` (at most 16 KiB), `toolCalls`, `toolName`/`isError` for a tool result, and
`timestamp`: when pi recorded the entry, from its own session file (ISO 8601): a user turn when it was taken, each
step of a reply when it ended. A reloaded conversation shows these, never the session's start time. `mirror` says
where the record is mirrored in the graph, or why it is not ("The mirror").

## Watch

Every durable event has a `seq` from 1; `since` is the last `seq` the client saw (0 for everything).
`watch` returns the events after `since`, at most 500 (`more: true` when there may be more). With `waitMs`
(at most 30 000) and nothing new, it waits for the next event. With `Accept: text/event-stream` the same route
streams: it replays from `since` (or `Last-Event-ID`), then follows live, each event as
`id: <seq>` / `event: <type>` / `data: <frame>`; it also streams `message.delta` text deltas, which are
ephemeral: no `seq`, never logged, never replayed. A client that disconnects resumes from its last `seq` with
no gap.

Event types (payloads in `schemas/event.schema.json`): `session.created`, `session.revived`,
`session.shutdown`, `session.forked`, `session.cloned`, `session.renamed`, `session.deleted`, `body.materialized`
(with `kind`: `in-process` or `rpc`, and an agent's `box`), `body.dormant`, `body.exited` (an agent body died: exit
code or signal, the tail of its stderr), `body.notice` (what an agent body's extensions told the person),
`lease.claimed`, `lease.renewed`, `lease.released`, `lease.revoked`, `lease.expired`,
`command.accepted`, `command.delivered`, `command.completed`,
`command.aborted`, `command.failed`, `command.cancelled`, `command.interrupted`, `run.started` (with the active
tools), `run.ended`, `run.settled`, `run.error`, `message.completed` (user, assistant with tool calls and usage),
`tool.started`, `tool.result`, `queue.updated`, `queue.stranded`, `budget.exceeded`, `room.policy`,
`chime.received`, `chime.resolved`, `compaction.started`, `compaction.ended`, `retry.started`,
`extension.error`, `abort.slow`, `mirror.written`, `mirror.failed`.

## Capsule

`sophia.vehicle-session-capsule.v2`: bounded and safe to hand over. It carries identity (session, graph,
profile, access, model, parent), posture (status, cursor, lease holder, budget), a command summary (counts and
the last 16 without text), up to 128 milestones (ids, statuses and counts only) and the last 32 transcript items:
assistant text (at most 4 KiB each) and tool names; user turns as their length only; tool results as name and
error flag. It never carries a secret, the system prompt, the text of a command or chime, tool arguments or
results, or any authority (`authority.mutations: false`).

## Chimes

A collaborator's attributed message, accepted by the room's policy (default `suggest`; the driver sets it with
`set_room_policy`):

- `observe`, `mute`: refused (`chime.rejected`);
- `suggest`: held as pending (`chime.received`) until the driver sends `accept_chime` or `reject_chime`;
- `co-drive`: submitted at once under the current driver's lease.

An accepted chime becomes a command whose text the model sees as `[<author> collaborator]\n<text>`: the
collaborator is named, never impersonating the driver.

## Public sessions

On a gardend in public mode (gardend's `docs/local-service-hosting.md`, "Public mode") people and agents with no login of
that Sophia reach the host as viewers of its public graphs: an anonymous visitor (`anon:<hash>`, from the
`X-Visitor-Id` its client keeps, else its address and user agent) or a Sophia account (`cognito:<sub>`, from a
Cognito ID token sent as `Authorization: Bearer`). gardend says which (`x-sophia-caller-kind`) and mints them
`viewer`: their sessions have the reader tools, are never mirrored into the graph, and their delegation token is a
viewer's. Each sees, lists, drives and deletes only its own sessions, as everyone does; a public session takes no
chimes.

**One conversation reads every public graph.** gardend names them (`x-sophia-public-graphs`) and binds a public
caller's delegation to all of them, read-only. The session lives on the graph of its path (`/g/<graph>/sessions`,
its `graphId`) and records the others at creation (`meta.graphs`); the model is told them, names one as `graphId`
in each tool call (none: the session's own), and pi-sophia's fence refuses any other.

Reading the data is free. **A conversation opens by one of two doors** (2026-10-14):

1. **Their own key.** `X-Model-Key: <OpenRouter key>` on the request that creates the session and on every
   request after it. The session's `funding` is `byok`; its body runs on a model runtime of its own holding that
   key (never the host's, so never the house key). The host keeps the newest key the session's owner sent, in
   memory only: never in `meta.json`, the logs, an event, the capsule, a listing, the mirror or pi's transcript
   (a provider error that quotes it is scrubbed before pi records it). After a restart a command that brings no
   key is refused (`model_key_required`) and the next one that brings it carries on. Any model of the provider
   (`VEHICLE_PUBLIC_PROVIDER`, default `openrouter`); with no `model`, `VEHICLE_PUBLIC_DEFAULT_MODEL`
   (`openrouter/openai/gpt-6-luna`).
2. **A Sophia account with credit.** No key, an account: the session's `funding` is `credit`, it runs on the
   house key, on one of the credit models (`VEHICLE_CREDIT_MODELS`; with no `model`,
   `VEHICLE_CREDIT_DEFAULT_MODEL`, `openrouter/deepseek/deepseek-v4.1-flash`). An account whose email is
   verified gets the signup credit once (`VEHICLE_SIGNUP_GRANT_USD`, $0.50), the first time the host sees it
   (`GET /account` or a session). Each run is debited by what it cost (pi's usage: the provider-reported cost,
   else the catalogue price). At zero a command is refused: "out of credit: paste your OpenRouter key (send it as
   X-Model-Key) to keep talking". All credit-funded spend in a UTC day, everyone together, is capped
   (`VEHICLE_CREDIT_DAILY_CAP_USD`, $5): past it, credit conversations are refused (`credit_pool_exhausted`) and
   own keys still work.

A visitor with neither is refused at `POST /sessions`: `402 model_key_required`, the message naming both doors and
`details.doors` saying how (`byok.header`, `account.header`).

**Limits** for every public turn (a `prompt`, `follow_up` or `steer`, either door), checked before it is accepted:
turns per principal per UTC day (`VEHICLE_PUBLIC_TURNS_PER_DAY`, 100: `daily_turn_limit`), turns per
conversation (`VEHICLE_PUBLIC_SESSION_MAX_TURNS`, 40: `session_turn_limit`), and each run's budget
(`VEHICLE_PUBLIC_RUN_MAX_TURNS` 8, `VEHICLE_PUBLIC_RUN_MAX_COST_USD` $0.05, whatever the request asks). A credit
run is checked before it starts, so a balance can end a run's cost below zero (at most one run's budget). gardend
adds its own per-address rate limits in front.

**`GET /account`**:

```json
{"kind": "account", "principal": "cognito:...", "email": "...", "emailVerified": true,
 "turnsToday": 3, "turnsPerDay": 100, "sessionMaxTurns": 40,
 "credit": {"balanceUsd": 0.4984, "grantedUsd": 0.5, "spentUsd": 0.0016,
            "defaultModel": "openrouter/deepseek/deepseek-v4.1-flash", "models": [...], "poolOpenToday": true},
 "doors": {...}, "byok": {"provider": "openrouter", "defaultModel": "openrouter/openai/gpt-6-luna"}}
```

A visitor gets `kind: "anonymous"` with its turns and the doors; this Sophia's own people `kind: "member"` (no
limits). **The ledger** is `$VEHICLE_DATA_DIR/public/ledger.jsonl`, append-only: `grant` rows (credit in, with
`source` = `signup`, `purchase` or `operator`), `debit` rows (a credit run's cost) and `turn` rows (every public
turn), each with its UTC `day`; grants and debits carry an idempotency key (`signup:<principal>`,
`run:<session>:<run>`, `purchase:<key>`), so a payment delivered twice credits once. `POST /account/grants` is how
a payment (later) or the operator adds credit.

## Budget

Each session has `maxTurns` and `maxCostUsd` per run (a pi agent loop: the prompt, the steering and follow-ups it
absorbs, and its tool turns); defaults 12 turns and $0.25, host-configurable, per-session overridable at creation.
When a finished turn reaches a cap and the run would continue, the guard aborts it before the next model request:
`budget.exceeded`, then `run.settled` with `aborted: true` and the reason; queued commands are cancelled.

## Durability

`$VEHICLE_DATA_DIR/sessions/<sessionId>/`: `meta.json` (fixed at creation but for the title), `commands.jsonl`
and `events.jsonl` (append-only), `pi/` (pi's own session file), `work/` (a chat body's empty working directory),
`mirror.json` (the mirror's state). The record also lives on in the graph, as the mirror's document.
An agent session's working folder is `$VEHICLE_DATA_DIR/workspaces/<sessionId>/`. A deleted session's directory
lives on in `$VEHICLE_DATA_DIR/trash/` (an agent's workspace as its `workspace/`). A body is mortal: it
is disposed after `VEHICLE_BODY_IDLE_MS` idle, at `shutdown` and when the host stops, and is materialized again
from pi's file on the next command. On restart the host rebuilds every session; commands that were open are
reported `interrupted`.

## The JSONL form

`vehicle ride` is the stdio form: a thin client over the HTTP routes, through gardend like every other
client. One request per line, `{"op": ..., "requestId": ..., ...}`, with the same bodies as above (`op`
also takes `claim`, `release`, `chime`, `inspect`, `capsule`, `watch` with `since`/`waitMs`, `rename` and
`delete`). One frame per line comes back, the host's own, with `requestId` added to reads. `ready` comes
first, and carries the session's summary, the cursor, `clientId` and whether the ride holds the lease.
`closed` comes last, on `shutdown` or `delete`, or at the end of the input; at the end of the input the ride
releases the lease it holds.

An agent needs only the URL of a public Sophia: `vehicle ride --gardend https://cow-tools.sophia-labs.com --graph
uruguay-cows --new`. With no token variable and no `--key-file`, a gardend that is not on this computer is ridden
as a visitor (`--anonymous` forces it): no `Authorization`, and an `X-Visitor-Id` kept in
`~/.local/state/vehicle/visitor-id` (or `--visitor-id`), so the visitor is the same from one ride to the next and
finds its sessions again (`--session <id>`). Its own model key comes from the environment (`VEHICLE_MODEL_KEY`,
or the variable `--model-key-env` names), never the command line, and goes with every request as `X-Model-Key`.
A Sophia account's ID token goes in the token variable (`VEHICLE_TOKEN`) like any bearer. A refusal is the host's `error` frame (its `code`, `message`, `details`) with
the request's `requestId`; a request that is not JSON, or has no `requestId`, is `invalid_json` or
`invalid_request`.
