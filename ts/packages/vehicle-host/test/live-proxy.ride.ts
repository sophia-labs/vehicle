/**
 * One live turn through the model proxy against OpenRouter (not part of the suite: run by hand, with the key in
 * OPENROUTER_API_KEY). The host holds the key; the agent's body in its box gets a proxy token only.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createSession, startHost } from "./harness.ts";

const key = process.env.OPENROUTER_API_KEY?.trim();
if (!key) throw new Error("OPENROUTER_API_KEY is not set");
delete process.env.OPENROUTER_API_KEY;
const tier = process.platform === "darwin" ? "seatbelt" : "bwrap";
const harness = await startHost({ agentBodies: { isolation: { tier, source: "VEHICLE_ISOLATION", allowUnisolatedAgent: false }, faux: false } });
try {
	await harness.modelRuntime.setRuntimeApiKey("openrouter", key);
	const sessionId = await createSession(harness, { profile: "agent", model: "openrouter/openai/gpt-6-luna" });
	const started = Date.now();
	const sent = await harness.call("POST", `/sessions/${sessionId}/commands`, { requestId: "live-1", op: "prompt", text: "Reply with exactly the word pong and nothing else." });
	assert.equal(sent.status, 200);
	const settled = await harness.waitFor(sessionId, (event) => event.type === "run.settled", 90_000);
	const events = await harness.events(sessionId, 0);
	const text = JSON.stringify(events);
	const files: string[] = [];
	const walk = (dir: string) => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			const stat = statSync(path, { throwIfNoEntry: false });
			if (stat?.isDirectory()) walk(path);
			else if (stat?.isFile() && readFileSync(path, "latin1").includes(key)) files.push(path);
		}
	};
	walk(harness.dataDir);
	const materialized = events.find((event) => event.type === "body.materialized")?.payload;
	const assistant = events.filter((event) => event.type === "message.completed" && event.payload.role === "assistant").map((event) => event.payload);
	const ended = events.find((event) => event.type === "run.ended")?.payload;
	console.log(
		JSON.stringify(
			{
				tier,
				box: materialized?.box,
				aborted: settled.payload.aborted ?? false,
				answer: assistant.map((message) => message.text),
				pong: assistant.some((message) => /pong/i.test(String(message.text))),
				runEnded: ended ?? null,
				eventTypes: [...new Set(events.map((event) => event.type))],
				keyInHostFiles: files.length,
				keyInEvents: text.includes(key),
				ms: Date.now() - started,
			},
			null,
			1,
		),
	);
} finally {
	await harness.cleanup();
}
