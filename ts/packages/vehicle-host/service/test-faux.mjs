/**
 * A test setting for a packaged service: `VEHICLE_TEST_FAUX=1` answers every model call with pi's own faux
 * provider (`@earendil-works/pi-ai`, the provider pi's test suite and vehicle-host's tests use), so a fresh
 * install can be proven end to end where no model key may go (a build box). No model is called and nothing is
 * billed. Never set it in a real install: the replies are canned.
 *
 *   VEHICLE_TEST_FAUX=1            the default model becomes `faux/faux-1`
 *   VEHICLE_TEST_FAUX_TOOL=<tool>  a turn first calls this graph tool (for example `list_documents`), with no
 *                                  arguments (pi-sophia binds the graph), then answers with what it returned
 *
 * Every reply starts with "faux:" and says what it heard, so nobody mistakes it for a model.
 */

import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

function textOf(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((block) => (block?.type === "text" ? block.text : "")).join("");
}

function clip(text, max) {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * The tools offered to the model. pi 1.2.0 declares them in the transcript (system messages with `toolsAdded` and
 * `toolsRemoved`), not in `context.tools`; both are read.
 */
function offeredTools(context) {
	const names = new Set((context.tools ?? []).map((tool) => tool.name));
	const nameOf = (tool) => (typeof tool === "string" ? tool : tool?.name);
	for (const message of context.messages ?? []) {
		if (message.role !== "system") continue;
		for (const tool of message.toolsAdded ?? []) names.add(nameOf(tool));
		for (const tool of message.toolsRemoved ?? []) names.delete(nameOf(tool));
	}
	return [...names].filter(Boolean);
}

/** One model call: the tool first (when asked for and offered), then an answer naming what came back. */
function respond(context) {
	const messages = (context.messages ?? []).filter((message) => message.role !== "system");
	const last = messages.at(-1);
	const wanted = process.env.VEHICLE_TEST_FAUX_TOOL?.trim();
	if (last?.role === "user" && wanted) {
		const tool = offeredTools(context).find((name) => name === wanted || name.endsWith(`__${wanted}`));
		if (tool) return fauxAssistantMessage([fauxToolCall(tool, {})], { stopReason: "toolUse" });
	}
	const asked = [...messages].reverse().find((message) => message.role === "user");
	let reply = `faux: heard "${clip(textOf(asked?.content), 80)}"`;
	if (last?.role === "toolResult") {
		const result = textOf(last.content);
		reply += `; ${last.toolName} returned ${result.length} characters${last.isError ? " (an error)" : ""}: ${clip(result, 240)}`;
	}
	return fauxAssistantMessage(reply);
}

/** Register the faux provider in every model runtime the host creates, and make it the default model. */
export function installFauxModel() {
	const faux = fauxProvider({ models: [{ id: "faux-1" }], tokensPerSecond: 400 });
	const step = (context) => {
		faux.appendResponses([step]);
		return respond(context);
	};
	// Kept topped up, so sessions answering at the same time never find the queue empty.
	faux.setResponses([step, step, step, step]);
	const create = ModelRuntime.create.bind(ModelRuntime);
	ModelRuntime.create = async (options) => {
		const runtime = await create(options);
		runtime.registerNativeProvider(faux.provider);
		await runtime.setRuntimeApiKey(faux.provider.id, "faux-key");
		return runtime;
	};
	process.env.VEHICLE_DEFAULT_MODEL = `${faux.provider.id}/faux-1`;
	console.warn("vehicle-host: VEHICLE_TEST_FAUX=1: every model call is answered by pi's faux provider (a test setting)");
}
