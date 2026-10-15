/**
 * `node --import` preload for `test-bundle.mjs`:
 *  - registers `bundle-test-resolve.mjs`, so the tests import the test bundle (`VEHICLE_TEST_BUNDLE`);
 *  - where a test starts the service entry as gardend would (`node --conditions=sophia-source src/main.ts`), it
 *    starts the shipped `app/main.mjs` instead (`VEHICLE_SERVICE_MAIN`), with the same arguments after it and the
 *    same environment.
 */
import childProcess from "node:child_process";
import { register, syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";

const bundle = process.env.VEHICLE_TEST_BUNDLE;
const serviceMain = process.env.VEHICLE_SERVICE_MAIN;
if (!bundle || !serviceMain) throw new Error("VEHICLE_TEST_BUNDLE and VEHICLE_SERVICE_MAIN must be set (test-bundle.mjs sets them)");

register("./bundle-test-resolve.mjs", import.meta.url, { data: { bundle: pathToFileURL(bundle).href } });

const spawn = childProcess.spawn;
export const redirected = [];
childProcess.spawn = function spawnShipped(command, args, options) {
	if (command === process.execPath && Array.isArray(args)) {
		const entry = args.findIndex((arg) => typeof arg === "string" && /[\\/]vehicle-host[\\/]src[\\/]main\.ts$/.test(arg));
		if (entry >= 0) {
			redirected.push(args[entry]);
			return spawn.call(this, command, [serviceMain, ...args.slice(entry + 1)], options);
		}
	}
	return spawn.call(this, command, args, options);
};
syncBuiltinESMExports();
