# Vehicle's agent host (TypeScript)

A pnpm workspace, Node.js 22.19 or later (pi's floor). pi is pinned exactly (`@earendil-works/pi-*` 1.2.0, held
by the overrides in `pnpm-workspace.yaml`) and never forked.

- `packages/pi-sophia` (`@sophia-labs/pi-sophia`): Sophia as one pi extension. It registers gardend's `/mcp`
  through pi's MCP support (the profile's tools `direct`, every other tool `hidden`), binds each graph tool call
  to the session's graph, replaces pi's coding preamble with Sophia's workspace prompt, keeps pi's built-in tools
  off in the `chat` profile, and caps turns and cost per run.
- `packages/vehicle-host` (`@sophia-labs/vehicle-host`): sessions through the pi SDK behind the ride protocol v2
  (`../protocol/ride-v2.md`): the lease, durable idempotent commands, watch (long-poll and SSE), capsule,
  fork and clone, chimes, the session mirror, and isolated bodies for the `agent` profile
  (`src/isolation.ts`, `src/rpc-body.ts`, `src/body-entry.ts`).

Under gardend, vehicle-host is the local service `vehicle` at `/services/vehicle`. gardend starts it from
`services/vehicle/service.json` beside its binary, mints who calls (`x-user-id`, the roles) and, on a graph path
(`/services/vehicle/g/<graph>/sessions...`), the graph (`x-graph-id`). It believes nothing else without the
per-spawn secret (`x-internal-service`). A session's body reaches gardend's loopback `/mcp` as the person, with
the delegation token gardend hands with their requests (`"delegateCaller": true`), bound to the session's graph.
See `../protocol/ride-v2.md` ("Trust").

```sh
pnpm install
pnpm test                       # pi's faux provider: no network, no keys; agent bodies in this platform's real box
VEHICLE_TEST_GARDEND_BIN=<gardend binary> pnpm test       # adds the real-gardend leg (its own throwaway profile)
scripts/package-service.sh <gardend dir>/services/vehicle # bundle (esbuild, about 10 MB) + service.json for gardend
node scripts/test-bundle.mjs <gardend dir>/services/vehicle  # vehicle-host's tests against that bundle
node scripts/ride-smoke.mjs --service <gardend dir>/services/vehicle   # one turn on it, pi's faux provider
```

By hand (outside gardend), give it what gardend would: `MNEMOSYNE_INTERNAL_SERVICE_SECRET`, `DATA_DIR`, `PORT`,
`MNEMOSYNE_MCP_URL` (`packages/vehicle-host/src/main.ts` lists them), and send `x-sophia-delegated-token` with
graph-scoped requests.

Licence: MIT (`LICENSE`). The bundled service carries `THIRD-PARTY-NOTICES.md` for everything bundled into it.
