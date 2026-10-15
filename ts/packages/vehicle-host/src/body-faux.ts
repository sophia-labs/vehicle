/**
 * A test setting for isolated bodies: pi's own faux provider (`@earendil-works/pi-ai`, the provider pi's test suite
 * uses), scripted by the person's words, so a real `pi --mode rpc` body in a real box can be driven end to end with
 * no model and no key (`bootstrap.faux`, set only by tests and by a host started with `VEHICLE_TEST_FAUX=1`).
 *
 * The newest user message says what the model does:
 *   `[tool <name> <json>]`  call that tool with those arguments; several run one after another, one per model call
 *   `[hold]`                wait until the run is aborted (at most 120 s), then answer "held"
 *   `[slow <ms>]`           wait that long (abortable), then answer
 * After the last tool it answers `faux: <tool> ok|error: <what the tool returned>`; otherwise `faux heard: <words>`.
 */

import { type FauxResponseFactory, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

const HOLD_MS = 120_000;

interface Message {
	readonly role: string;
	readonly content?: unknown;
	readonly toolName?: string;
	readonly isError?: boolean;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((block: { type?: string; text?: string }) => (block?.type === "text" ? (block.text ?? "") : "")).join("\n");
}

/** Every `[tool <name> <json>]` in the text, in order. The JSON is read by bracket counting, strings respected. */
export function toolDirectives(text: string): { name: string; args: Record<string, unknown> }[] {
	const out: { name: string; args: Record<string, unknown> }[] = [];
	const head = /\[tool ([A-Za-z0-9_.:-]+) /g;
	for (let match = head.exec(text); match; match = head.exec(text)) {
		const start = match.index + match[0].length;
		if (text[start] !== "{") continue;
		let depth = 0;
		let inString = false;
		let end = -1;
		for (let index = start; index < text.length; index += 1) {
			const char = text[index];
			if (inString) {
				if (char === "\\") index += 1;
				else if (char === '"') inString = false;
			} else if (char === '"') inString = true;
			else if (char === "{") depth += 1;
			else if (char === "}") {
				depth -= 1;
				if (depth === 0) {
					end = index;
					break;
				}
			}
		}
		if (end < 0) continue;
		try {
			out.push({ name: match[1] as string, args: JSON.parse(text.slice(start, end + 1)) as Record<string, unknown> });
		} catch {
			// not JSON: not a directive
		}
		head.lastIndex = end + 1;
	}
	return out;
}

function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
	if (signal?.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const timer = setTimeout(done, ms);
		function done() {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolve();
		}
		signal?.addEventListener("abort", done, { once: true });
	});
}

const clip = (text: string, max: number) => {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

export function installBodyFaux(modelRuntime: ModelRuntime): void {
	const faux = fauxProvider({ models: [{ id: "faux-1" }], tokensPerSecond: 2000 });
	const answer: FauxResponseFactory = async (context, options) => {
		faux.appendResponses([answer]);
		const messages = (context.messages as readonly Message[]).filter((message) => message.role !== "system");
		let lastUser = -1;
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			if (messages[index]?.role === "user") {
				lastUser = index;
				break;
			}
		}
		const heard = textOf(messages[lastUser]?.content);
		const results = messages.slice(lastUser + 1).filter((message) => message.role === "toolResult");
		const directives = toolDirectives(heard);
		const next = directives[results.length];
		if (next) return fauxAssistantMessage([fauxToolCall(next.name, next.args as Parameters<typeof fauxToolCall>[1])], { stopReason: "toolUse" });
		if (heard.includes("[hold]")) {
			await pause(HOLD_MS, options?.signal);
			return fauxAssistantMessage("held");
		}
		const slow = /\[slow (\d{1,6})\]/.exec(heard);
		if (slow) await pause(Number(slow[1]), options?.signal);
		const last = results.at(-1);
		if (last) return fauxAssistantMessage(`faux: ${last.toolName} ${last.isError ? "error" : "ok"}: ${clip(textOf(last.content), 1500)}`);
		return fauxAssistantMessage(`faux heard: ${clip(heard, 400)}`);
	};
	faux.setResponses([answer]);
	modelRuntime.registerNativeProvider(faux.provider);
}
