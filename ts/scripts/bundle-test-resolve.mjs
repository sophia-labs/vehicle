/**
 * Module hooks for `test-bundle.mjs` (registered by `bundle-test-preload.mjs`): the tests' imports of vehicle-host
 * (`../src/index.ts`) and of pi (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`) resolve to the test
 * bundle, so the suite drives the bundled code with the bundle's own pi. Nothing else is touched.
 */
let bundle;

export async function initialize(data) {
	bundle = data.bundle;
}

const PI = new Set(["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent"]);

export async function resolve(specifier, context, nextResolve) {
	if (PI.has(specifier)) return { url: bundle, shortCircuit: true, format: "module" };
	if (specifier === "../src/index.ts" && context.parentURL?.includes("/vehicle-host/test/")) {
		return { url: bundle, shortCircuit: true, format: "module" };
	}
	return nextResolve(specifier, context);
}
