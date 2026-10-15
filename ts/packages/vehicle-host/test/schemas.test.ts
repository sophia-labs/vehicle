/**
 * The protocol's JSON schemas hold for what the host really sends and accepts: every request this test sends,
 * every frame and event it gets back, and the capsule. Validated with the JSON Schema compiler pi itself uses
 * for MCP tool schemas (`typebox/compile`).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Compile } from "typebox/compile";
import { createSession, startHost } from "./harness.ts";

const dir = join(fileURLToPath(import.meta.url), "../../../../../protocol/schemas");
const schema = (name: string) => {
	const validator = Compile(JSON.parse(readFileSync(join(dir, `${name}.schema.json`), "utf8")));
	return (value: unknown, label: string) => {
		if (!validator.Check(value)) {
			assert.fail(`${label} does not match ${name}: ${JSON.stringify([...validator.Errors(value)].slice(0, 3))}\n${JSON.stringify(value).slice(0, 600)}`);
		}
	};
};

describe("the protocol schemas", () => {
	it("describe the requests, frames, events and capsule the host really exchanges", async () => {
		const frame = schema("frame");
		const event = schema("event");
		const capsule = schema("capsule");
		const command = schema("command.request");
		const create = schema("create-session.request");
		const lease = schema("lease.request");
		const chime = schema("chime.request");
		const rename = schema("rename-session.request");
		const snapshotValue = schema("snapshot");
		const harness = await startHost();
		try {
			harness.faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
			const createBody = { requestId: "s-1", title: "schemas", budget: { maxTurns: 4 } };
			create(createBody, "create request");
			const created = await harness.call("POST", "/sessions", createBody);
			frame(created.body, "create frame");
			const sessionId = created.body.value.session.sessionId as string;
			const requests = [
				{ requestId: "p-1", op: "prompt", text: "hello", contextRefs: ["doc-1"] },
				{ requestId: "pol-1", op: "set_room_policy", policy: "co-drive" },
			];
			for (const body of requests) {
				command(body, `request ${body.requestId}`);
				frame((await harness.call("POST", `/sessions/${sessionId}/commands`, body)).body, `frame ${body.requestId}`);
			}
			await harness.waitFor(sessionId, (e) => e.type === "run.settled");
			const chimeBody = { requestId: "ch-1", author: "Codex", delivery: "follow_up", text: "Check the second item" };
			chime(chimeBody, "chime request");
			frame((await harness.call("POST", `/sessions/${sessionId}/chimes`, chimeBody, { principal: "collaborator", role: "viewer", clientId: "codex" })).body, "chime frame");
			await harness.waitFor(sessionId, (e) => e.type === "run.settled" && e.seq > 12);
			lease({ requestId: "r-1" }, "release request");
			frame((await harness.call("POST", `/sessions/${sessionId}/release`, { requestId: "r-1" })).body, "release frame");
			frame((await harness.call("POST", `/sessions/${sessionId}/commands`, { requestId: "x", op: "prompt", text: "no lease" })).body, "error frame");
			const snapshot = await harness.call("GET", `/sessions/${sessionId}`);
			frame(snapshot.body, "inspect frame");
			snapshotValue(snapshot.body.value, "inspect value");
			const watched = await harness.call("GET", `/sessions/${sessionId}/events?since=0`);
			frame(watched.body, "watch frame");
			const events = watched.body.value.events as unknown[];
			assert.ok(events.length > 15);
			events.forEach((e, index) => event(e, `event ${index}`));
			const capsuleFrame = await harness.call("GET", `/sessions/${sessionId}/capsule`);
			frame(capsuleFrame.body, "capsule frame");
			capsule(capsuleFrame.body.value, "capsule");
			// The co-drive chime reached the model, attributed.
			const users = (snapshot.body.value.transcript as { role: string; text: string }[]).filter((item) => item.role === "user");
			assert.equal(users.at(-1)?.text, "[Codex collaborator]\nCheck the second item");
			// And the schemas refuse what they must refuse.
			const leaky = structuredClone(capsuleFrame.body.value);
			leaky.transcript.push({ entryId: "x", role: "user", chars: 5, text: "hello" });
			assert.throws(() => capsule(leaky, "leaky capsule"));
			assert.throws(() => command({ requestId: "y", op: "steer" }, "steer without text"));

			// The person's own: another of their clients takes the conversation over, renames it, deletes it.
			const other = { principal: "carol", role: "owner", clientId: "second-browser" };
			const reclaim = { requestId: "c-back" };
			lease(reclaim, "claim request");
			frame((await harness.call("POST", `/sessions/${sessionId}/claim`, reclaim)).body, "claim frame");
			const held = await harness.call("POST", `/sessions/${sessionId}/claim`, { requestId: "c-held" }, other);
			frame(held.body, "lease_held frame");
			assert.equal(held.body.details.canTakeOver, true);
			const takeover = { requestId: "c-take", takeover: true };
			lease(takeover, "takeover request");
			frame((await harness.call("POST", `/sessions/${sessionId}/claim`, takeover, other)).body, "takeover frame");
			const renameBody = { requestId: "n-1", title: "Schemas, renamed" };
			rename(renameBody, "rename request");
			rename({ title: null }, "clearing rename request");
			assert.throws(() => rename({ title: "x".repeat(201) }, "too long a title"));
			assert.throws(() => rename({}, "rename without a title"));
			frame((await harness.call("PATCH", `/sessions/${sessionId}`, renameBody)).body, "rename frame");
			const after = (await harness.call("GET", `/sessions/${sessionId}/events?since=0`)).body.value.events as { type: string }[];
			after.forEach((e, index) => event(e, `event ${index} after the takeover`));
			for (const type of ["lease.revoked", "session.renamed"]) assert.ok(after.some((e) => e.type === type), `${type} was seen`);
			snapshotValue((await harness.call("GET", `/sessions/${sessionId}`)).body.value, "inspect value after the rename");
			const deleted = await harness.call("DELETE", `/sessions/${sessionId}`);
			frame(deleted.body, "delete frame");
			const trashed = readFileSync(join(harness.dataDir, "trash", sessionId, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
			event(trashed.at(-1), "the deletion event");
			assert.equal(trashed.at(-1).type, "session.deleted");
			frame((await harness.call("DELETE", `/sessions/${sessionId}`)).body, "delete-again error frame");
		} finally {
			await harness.cleanup();
		}
	});
});
