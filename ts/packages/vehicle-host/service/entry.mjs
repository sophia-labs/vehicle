/**
 * The entry of the bundled service: `ts/scripts/build-service.mjs` bundles this file, `src/main.ts`, pi and every
 * dependency into one `app/main.mjs`, which gardend starts from `services/vehicle/service.json`.
 *
 * Before anything of pi loads, it
 *   - refuses a Node older than pi's floor with a sentence a person can act on (gardend checks the same before it
 *     starts the service; this is for a hand start);
 *   - points pi at its own package.json (`app/pi/`), which pi reads for its name and version, because a bundle
 *     has no node_modules to find it in;
 *   - with `VEHICLE_TEST_FAUX=1` only (a test setting, never set in a release), answers every model call with
 *     pi's faux provider (`./test-faux.mjs`): no model is called and no key is needed.
 * Then it runs `src/main.ts`, unchanged.
 *
 * The same file is an isolated body's entry: `node app/main.mjs --vehicle-body` runs `src/body-entry.ts` (pi's RPC
 * mode for an `agent` session, inside its box). The host finds it through `VEHICLE_BODY_ENTRY`, set here.
 */

import { fileURLToPath } from "node:url";

const NODE_FLOOR = [22, 19];
const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
if (major < NODE_FLOOR[0] || (major === NODE_FLOOR[0] && minor < NODE_FLOOR[1])) {
	console.error(
		`vehicle-host: Node ${NODE_FLOOR.join(".")} or later is needed (this is ${process.versions.node}); put a newer node first on gardend's PATH`,
	);
	process.exit(2);
}

process.env.PI_PACKAGE_DIR ??= fileURLToPath(new URL("./pi/", import.meta.url));

if (process.argv[2] === "--vehicle-body") {
	await import("../src/body-entry.ts");
} else {
	// The host starts its agent bodies from this same file.
	process.env.VEHICLE_BODY_ENTRY ??= fileURLToPath(import.meta.url);
	if (process.env.VEHICLE_TEST_FAUX === "1") {
		const { installFauxModel } = await import("./test-faux.mjs");
		installFauxModel();
	}
	await import("../src/main.ts");
}
