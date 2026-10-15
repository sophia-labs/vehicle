import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sophiaExtensionFromEnv } from "./extension.ts";

export * from "./budget.ts";
export * from "./extension.ts";
export * from "./graph-binding.ts";
export * from "./manifest.ts";
export * from "./prompt.ts";

/** pi's entry point when the package is loaded as an extension: configured from the environment. */
export default function piSophia(pi: ExtensionAPI): void | Promise<void> {
	return sophiaExtensionFromEnv()(pi);
}
