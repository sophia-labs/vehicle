/**
 * The entry of the test bundle (`build-service.mjs --test-bundle`): vehicle-host's library and the pi pieces its
 * tests use, bundled once with the service's own esbuild options, so pi's classes in the tests are the bundle's.
 * `ts/scripts/test-bundle.mjs` points the tests' imports here. Not shipped.
 */
export * from "../src/index.ts";
export { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, getSystemMessageText } from "@earendil-works/pi-ai";
export { ModelRuntime } from "@earendil-works/pi-coding-agent";
