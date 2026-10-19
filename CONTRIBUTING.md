# Contributing to Vehicle

This is the one canonical repository for Vehicle: there is no private mirror and no export step. Pull requests land here and
what is on `main` is what runs.

Vehicle is MIT-licensed. By contributing you agree your contribution is under the same licence.

## Run these locally before opening a PR

CI runs exactly these, so a green local run is a green PR.

```bash
# The Rust crate (the terminal client, the protocol, the room and pty tests)
cargo test --locked

# The TypeScript packages (pi-sophia, vehicle-host)
cd ts
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
```

Needs Node >= 22.19, pnpm (the version `ts/package.json` pins) and a stable Rust toolchain.

Some Rust tests ride a real gardend: set `VEHICLE_TEST_GARDEND=<path to a gardend binary>` to run them (get a binary from
[`sophia-labs/gardend`](https://github.com/sophia-labs/gardend)); without it they print `SKIPPED` and pass.

## House rules

- Real tests, no mocks. A test drives the real code path (a real process, a real socket, a real gardend), not a stand-in.
- Keep a change small and say what you ran in the PR description.
- Do not commit keys, tokens, or personal data. Examples use `carol` and `demo-graph`.
