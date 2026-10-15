#!/usr/bin/env node
/**
 * Run vehicle-host's own test suite against the bundled build, not the source:
 *
 *   node scripts/test-bundle.mjs [<service dir>]
 *
 * Builds the service (into a temporary dir, unless one built by `build-service.mjs` is given) and a test bundle
 * (vehicle-host's library + the pi pieces the tests use, with the service's esbuild options), then runs
 * `packages/vehicle-host/test/*.test.ts` with their imports pointed at the test bundle and the service-entry tests
 * starting the shipped `app/main.mjs` (`bundle-test-preload.mjs`), and every agent body started from it
 * (`app/main.mjs --vehicle-body`, through `VEHICLE_BODY_ENTRY`). pi's faux provider, no network, no keys; the
 * real-gardend leg joins when `SOPHIA_GARDEND_MCP_URL` and `SOPHIA_GARDEND_TOKEN` are set, as in `pnpm test`.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ts = dirname(here);
const scratch = mkdtempSync(join(tmpdir(), "vehicle-test-bundle-"));
try {
	let service = process.argv[2] ? resolve(process.argv[2]) : join(scratch, "service");
	if (!process.argv[2]) execFileSync(process.execPath, [join(here, "build-service.mjs"), service], { stdio: "inherit" });
	const main = join(service, "app", "main.mjs");
	if (!existsSync(main)) throw new Error(`${main} is missing`);
	const bundle = join(scratch, "test-bundle.mjs");
	execFileSync(process.execPath, [join(here, "build-service.mjs"), "--test-bundle", bundle], { stdio: "inherit" });
	const testDir = join(ts, "packages", "vehicle-host", "test");
	const tests = readdirSync(testDir).filter((name) => name.endsWith(".test.ts")).map((name) => join(testDir, name));
	const run = spawnSync(
		process.execPath,
		["--conditions=sophia-source", "--import", join(here, "bundle-test-preload.mjs"), "--test", "--test-concurrency=1", ...tests],
		{
			cwd: join(ts, "packages", "vehicle-host"),
			stdio: "inherit",
			// Agent bodies start from the shipped bundle too (`app/main.mjs --vehicle-body`).
			env: { ...process.env, VEHICLE_TEST_BUNDLE: bundle, VEHICLE_SERVICE_MAIN: main, VEHICLE_BODY_ENTRY: main },
		},
	);
	process.exitCode = run.status ?? 1;
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
