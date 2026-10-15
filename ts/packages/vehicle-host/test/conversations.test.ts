/**
 * A person's own conversations: rename, delete (to the trash, never unlinked), the same person taking a
 * conversation over from another of their clients, and the transcript's own times. Real HTTP against a real
 * host on a temporary data dir; pi's faux provider for model-free turns.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createSession, DRIVER, gate, type Harness, held, type Identity, SECOND, SECRET, STRANGER, startHost, TEST_GRAPH } from "./harness.ts";

/** Read an SSE watch until `stop` says so or the server ends the stream; returns the event types seen, in order. */
async function readStream(
	harness: Harness,
	sessionId: string,
	since: number,
	who: Identity,
	stop: (types: string[]) => boolean,
	timeoutMs = 10_000,
): Promise<{ types: string[]; payloads: Record<string, any>[]; ended: boolean }> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const response = await fetch(`${harness.url}/sessions/${sessionId}/events?since=${since}`, {
		headers: {
			accept: "text/event-stream",
			"x-internal-service": SECRET,
			"x-user-id": who.principal ?? "",
			"x-graph-id": TEST_GRAPH,
			"x-sophia-graph-role": who.role ?? "owner",
			"x-vehicle-client-id": who.clientId ?? "",
		},
		signal: controller.signal,
	});
	assert.equal(response.status, 200);
	const reader = response.body!.getReader();
	const types: string[] = [];
	const payloads: Record<string, any>[] = [];
	let buffer = "";
	let ended = false;
	try {
		while (!stop(types)) {
			const { value, done } = await reader.read();
			if (done) {
				ended = true;
				break;
			}
			buffer += new TextDecoder().decode(value);
			let split = buffer.indexOf("\n\n");
			while (split >= 0) {
				const block = buffer.slice(0, split);
				buffer = buffer.slice(split + 2);
				const data = block.split("\n").find((line) => line.startsWith("data: "));
				if (data) {
					const frame = JSON.parse(data.slice(6)) as { ephemeral?: boolean; event: { type: string; payload: Record<string, any> } };
					if (!frame.ephemeral) {
						types.push(frame.event.type);
						payloads.push(frame.event.payload);
					}
				}
				split = buffer.indexOf("\n\n");
			}
		}
	} finally {
		clearTimeout(timer);
		controller.abort();
	}
	return { types, payloads, ended };
}

const cursorOf = async (harness: Harness, sessionId: string, who: Identity = DRIVER) => (await harness.events(sessionId, 0, who)).at(-1)?.seq ?? 0;

describe("rename", () => {
	let harness: Harness;
	before(async () => {
		harness = await startHost();
	});
	after(async () => harness.cleanup());

	it("names the conversation in its metadata: listed by it, after a restart too; null names it by its preview again", async () => {
		harness.faux.setResponses([fauxAssistantMessage("The TPS63020.")]);
		const sessionId = await createSession(harness);
		await harness.call("POST", `/sessions/${sessionId}/commands`, { requestId: "p-1", op: "prompt", text: "Which part regulates the 3.3 V rail?" });
		await harness.waitFor(sessionId, (event) => event.type === "run.settled");

		const renamed = await harness.call("PATCH", `/sessions/${sessionId}`, { requestId: "n-1", title: "  Power\nbudget  " });
		assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
		assert.equal(renamed.body.type, "session.renamed");
		assert.equal(renamed.body.requestId, "n-1");
		assert.equal(renamed.body.value.session.title, "Power budget");
		const meta = JSON.parse(readFileSync(join(harness.dataDir, "sessions", sessionId, "meta.json"), "utf8"));
		assert.equal(meta.title, "Power budget");
		assert.equal(meta.owner, "carol", "the rest of the record is as it was");
		const listed = (await harness.call("GET", "/sessions")).body.value.sessions as Record<string, unknown>[];
		assert.equal(listed.find((row) => row.sessionId === sessionId)?.title, "Power budget");
		const event = (await harness.events(sessionId)).at(-1);
		assert.equal(event?.type, "session.renamed");
		assert.deepEqual(event?.payload, { title: "Power budget", by: DRIVER.clientId });

		// Any of the owner's clients may rename it: the lease is for driving, not for naming.
		assert.equal((await harness.call("PATCH", `/sessions/${sessionId}`, { title: "Power budget, v2" }, SECOND)).status, 200);

		// Survives the host.
		await harness.stop();
		const revived = await startHost({ dataDir: harness.dataDir });
		try {
			const again = (await revived.call("GET", "/sessions")).body.value.sessions as Record<string, unknown>[];
			assert.equal(again.find((row) => row.sessionId === sessionId)?.title, "Power budget, v2");
			const cleared = await revived.call("PATCH", `/sessions/${sessionId}`, { title: null });
			assert.equal(cleared.status, 200);
			assert.equal(cleared.body.value.session.title, undefined);
			assert.equal(cleared.body.value.session.preview, "Which part regulates the 3.3 V rail?");
		} finally {
			await revived.stop();
			harness = await startHost({ dataDir: harness.dataDir });
		}
	});

	it("is the owner's: another principal or another graph finds no such session; a bad title is refused", async () => {
		const sessionId = await createSession(harness, { title: "mine" });
		const stranger = await harness.call("PATCH", `/sessions/${sessionId}`, { title: "theirs" }, STRANGER);
		assert.equal(stranger.status, 404);
		const elsewhere = await harness.call("PATCH", `/sessions/${sessionId}`, { title: "elsewhere" }, { ...DRIVER, graphId: "other-graph" });
		assert.equal(elsewhere.status, 404);
		assert.equal((await harness.call("PATCH", `/sessions/${sessionId}`, { title: "x".repeat(201) })).body.code, "invalid_request");
		assert.equal((await harness.call("PATCH", `/sessions/${sessionId}`, { title: 7 })).body.code, "invalid_request");
		assert.equal((await harness.call("PATCH", `/sessions/${sessionId}`, {})).body.code, "invalid_request");
		// A role cut to read-only may still name its own conversation (it changes no workspace).
		assert.equal((await harness.call("PATCH", `/sessions/${sessionId}`, { title: "still mine" }, { ...DRIVER, role: "viewer" })).status, 200);
		const snapshot = await harness.call("GET", `/sessions/${sessionId}`);
		assert.equal(snapshot.body.value.session.title, "still mine");
	});
});

describe("delete", () => {
	let harness: Harness;
	before(async () => {
		harness = await startHost();
	});
	after(async () => harness.cleanup());

	it("moves the whole record to trash/ (never unlinked), ends every watch, and the session is gone: not listed, 404, not revived", async () => {
		harness.faux.setResponses([fauxAssistantMessage("Noted.")]);
		const sessionId = await createSession(harness, { title: "doomed" });
		await harness.call("POST", `/sessions/${sessionId}/commands`, { requestId: "p-1", op: "prompt", text: "Remember this." });
		await harness.waitFor(sessionId, (event) => event.type === "run.settled");
		const piFile = harness.host.piFileOf(sessionId) as string;
		const piName = piFile.split("/").at(-1) as string;
		const piText = readFileSync(piFile, "utf8");
		const cursor = await cursorOf(harness, sessionId);

		// Another of the owner's clients watches by SSE, a third by long-poll.
		const streaming = readStream(harness, sessionId, cursor, SECOND, (types) => types.includes("never"));
		const polling = harness.call("GET", `/sessions/${sessionId}/events?since=${cursor}&waitMs=30000`, undefined, { ...DRIVER, clientId: "poller" });
		await new Promise((resolve) => setTimeout(resolve, 150));

		const deleted = await harness.call("DELETE", `/sessions/${sessionId}`);
		assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
		assert.equal(deleted.body.type, "session.deleted");
		assert.deepEqual(deleted.body.value, { sessionId, trashedAs: sessionId });

		const stream = await streaming;
		assert.equal(stream.ended, true, "the stream ends with the deletion");
		assert.equal(stream.types.at(-1), "session.deleted");
		const poll = await polling;
		assert.equal(poll.body.value.events.at(-1).type, "session.deleted");

		// The record, whole, in the trash.
		assert.equal(existsSync(join(harness.dataDir, "sessions", sessionId)), false);
		const trashed = join(harness.dataDir, "trash", sessionId);
		for (const name of ["meta.json", "commands.jsonl", "events.jsonl", "deleted.json", "pi"]) assert.ok(existsSync(join(trashed, name)), `trash has ${name}`);
		assert.equal(readFileSync(join(trashed, "pi", piName), "utf8"), piText, "pi's conversation is kept byte for byte");
		const note = JSON.parse(readFileSync(join(trashed, "deleted.json"), "utf8"));
		assert.equal(note.sessionId, sessionId);
		assert.equal(note.by.clientId, DRIVER.clientId);
		assert.match(note.restore, /sessions\//);
		const lastEvent = readFileSync(join(trashed, "events.jsonl"), "utf8").trim().split("\n").at(-1) as string;
		assert.equal(JSON.parse(lastEvent).type, "session.deleted", "the deletion is the last line of the moved log");

		// Gone.
		assert.equal((await harness.call("GET", `/sessions/${sessionId}`)).status, 404);
		assert.equal((await harness.call("GET", `/sessions/${sessionId}/events?since=0`)).status, 404);
		assert.equal((await harness.call("POST", `/sessions/${sessionId}/commands`, { requestId: "p-2", op: "prompt", text: "hi" })).status, 404);
		assert.equal((await harness.call("DELETE", `/sessions/${sessionId}`)).status, 404);
		const listed = (await harness.call("GET", "/sessions")).body.value.sessions as Record<string, unknown>[];
		assert.equal(listed.some((row) => row.sessionId === sessionId), false);
		await harness.stop();
		harness = await startHost({ dataDir: harness.dataDir });
		assert.equal(harness.host.sessions.has(sessionId), false, "the trash is not revived");

		// Restore is a move back while the service is stopped.
		await harness.stop();
		renameSync(trashed, join(harness.dataDir, "sessions", sessionId));
		harness = await startHost({ dataDir: harness.dataDir });
		const restored = await harness.call("GET", `/sessions/${sessionId}`);
		assert.equal(restored.status, 200);
		assert.deepEqual(
			(restored.body.value.transcript as { role: string; text: string }[]).map((item) => [item.role, item.text]),
			[["user", "Remember this."], ["assistant", "Noted."]],
		);
	});

	it("is the owner's: another principal, or the owner through another graph, finds no such session, and it stays", async () => {
		const sessionId = await createSession(harness);
		assert.equal((await harness.call("DELETE", `/sessions/${sessionId}`, undefined, STRANGER)).status, 404);
		assert.equal((await harness.call("DELETE", `/sessions/${sessionId}`, undefined, { ...STRANGER, role: "owner", principal: "the-graph-owner" })).status, 404);
		assert.equal((await harness.call("DELETE", `/sessions/${sessionId}`, undefined, { ...DRIVER, graphId: "other-graph" })).status, 404);
		assert.equal((await harness.call("GET", `/sessions/${sessionId}`)).status, 200);
		assert.ok(existsSync(join(harness.dataDir, "sessions", sessionId)));
	});

	it("lets an owner whose role dropped to read-only delete their own writer conversation (not drive it)", async () => {
		const sessionId = await createSession(harness, {}, { ...DRIVER, role: "editor" });
		const reduced = { ...DRIVER, role: "viewer" };
		assert.equal((await harness.call("POST", `/sessions/${sessionId}/commands`, { requestId: "p", op: "prompt", text: "x" }, reduced)).body.code, "access_reduced");
		const deleted = await harness.call("DELETE", `/sessions/${sessionId}`, undefined, reduced);
		assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
	});

	it("is refused while a run is under way (session_running), and goes through once it settled", async () => {
		const hold = gate();
		harness.faux.setResponses([
			async (_context, options) => {
				await held(hold, options);
				return fauxAssistantMessage("done at last");
			},
		]);
		const sessionId = await createSession(harness);
		await harness.call("POST", `/sessions/${sessionId}/commands`, { requestId: "p-1", op: "prompt", text: "Take your time" });
		await harness.waitFor(sessionId, (event) => event.type === "run.started");
		// Even from another of the owner's clients: deleting never cuts off a reply someone is watching.
		const refused = await harness.call("DELETE", `/sessions/${sessionId}`, undefined, SECOND);
		assert.equal(refused.status, 409);
		assert.equal(refused.body.code, "session_running");
		assert.deepEqual(refused.body.details.open, ["p-1"]);
		assert.ok(existsSync(join(harness.dataDir, "sessions", sessionId)));
		hold.open();
		await harness.waitFor(sessionId, (event) => event.type === "run.settled");
		assert.equal((await harness.call("DELETE", `/sessions/${sessionId}`, undefined, SECOND)).status, 200);
	});
});

describe("the same person takes a conversation over", () => {
	let harness: Harness;
	before(async () => {
		harness = await startHost();
	});
	after(async () => harness.cleanup());

	it("revokes the other client's lease only for the same principal; the old holder's watch says so and it can no longer drive", async () => {
		harness.faux.setResponses([fauxAssistantMessage("from the second tab"), fauxAssistantMessage("from the first tab again")]);
		const sessionId = await createSession(harness);
		const cursor = await cursorOf(harness, sessionId);
		const watching = readStream(harness, sessionId, cursor, DRIVER, (types) => types.includes("lease.claimed"));
		await new Promise((resolve) => setTimeout(resolve, 100));

		// Without takeover: held, and the refusal says this caller could take it over.
		const plain = await harness.call("POST", `/sessions/${sessionId}/claim`, { requestId: "c-1" }, SECOND);
		assert.equal(plain.status, 409);
		assert.equal(plain.body.code, "lease_held");
		assert.equal(plain.body.details.holder.clientId, DRIVER.clientId);
		assert.equal(plain.body.details.canTakeOver, true);

		const taken = await harness.call("POST", `/sessions/${sessionId}/claim`, { requestId: "c-2", takeover: true }, SECOND);
		assert.equal(taken.status, 200, JSON.stringify(taken.body));
		assert.equal(taken.body.value.lease.clientId, SECOND.clientId);
		assert.equal(taken.body.value.tookOverFrom.clientId, DRIVER.clientId);
		// Replayed, not repeated.
		const replay = await harness.call("POST", `/sessions/${sessionId}/claim`, { requestId: "c-2", takeover: true }, SECOND);
		assert.equal(replay.body.replayed, true);

		// The old holder's watch saw its lease revoked, then the new holder's claim.
		const seen = await watching;
		const revokedAt = seen.types.indexOf("lease.revoked");
		assert.ok(revokedAt >= 0, seen.types.join(","));
		assert.deepEqual(seen.payloads[revokedAt], { clientId: DRIVER.clientId, by: SECOND.clientId, reason: "takeover" });
		assert.equal(seen.types[revokedAt + 1], "lease.claimed");
		assert.equal(seen.payloads[revokedAt + 1]?.clientId, SECOND.clientId);

		// The old holder is now refused (and could take it back); the new one drives.
		const old = await harness.call("POST", `/sessions/${sessionId}/commands`, { requestId: "p-old", op: "prompt", text: "still me?" });
		assert.equal(old.status, 409);
		assert.equal(old.body.code, "lease_held");
		assert.equal(old.body.details.canTakeOver, true);
		const fresh = await harness.call("POST", `/sessions/${sessionId}/commands`, { requestId: "p-new", op: "prompt", text: "here now" }, SECOND);
		assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
		await harness.waitFor(sessionId, (event) => event.type === "run.settled");
		const back = await harness.call("POST", `/sessions/${sessionId}/claim`, { requestId: "c-3", takeover: true });
		assert.equal(back.status, 200);
		assert.equal(back.body.value.tookOverFrom.clientId, SECOND.clientId);
		const beforeAgain = await cursorOf(harness, sessionId);
		assert.equal((await harness.call("POST", `/sessions/${sessionId}/commands`, { requestId: "p-again", op: "prompt", text: "mine again" })).status, 200);
		await harness.waitFor(sessionId, (event) => event.type === "run.settled" && event.seq > beforeAgain);
		assert.equal(harness.faux.state.callCount, 2, "nothing the refused client sent reached the model");
	});

	it("never for another principal: someone else finds no such session, and a role cut to read-only cannot take a writer's", async () => {
		const sessionId = await createSession(harness);
		const stranger = await harness.call("POST", `/sessions/${sessionId}/claim`, { requestId: "c-s", takeover: true }, STRANGER);
		assert.equal(stranger.status, 404);
		const reduced = await harness.call("POST", `/sessions/${sessionId}/claim`, { requestId: "c-r", takeover: true }, { ...SECOND, role: "viewer" });
		assert.equal(reduced.status, 403);
		assert.equal(reduced.body.code, "access_reduced");
		const snapshot = await harness.call("GET", `/sessions/${sessionId}`);
		assert.equal(snapshot.body.value.session.lease.clientId, DRIVER.clientId, "the lease did not move");
		assert.equal((await harness.call("POST", `/sessions/${sessionId}/claim`, { requestId: "c-bad", takeover: "yes" }, SECOND)).body.code, "invalid_request");
	});

	it("refuses a takeover of a lease another principal holds (lease_held, canTakeOver false), whatever the record says", async () => {
		// A lease held by another principal: today only the owner can claim, so it is written into the record as
		// a shared-session host would have, and the host revives it.
		const sessionId = await createSession(harness);
		await harness.call("POST", `/sessions/${sessionId}/release`, { requestId: "r-1" });
		const log = join(harness.dataDir, "sessions", sessionId, "events.jsonl");
		const seq = (await cursorOf(harness, sessionId)) + 1;
		const expiresAt = Date.now() + 600_000;
		const claimedAt = new Date().toISOString();
		await harness.stop();
		writeFileSync(log, `${readFileSync(log, "utf8")}${JSON.stringify({ seq, ts: claimedAt, type: "lease.claimed", payload: { clientId: "their-tab", principal: "someone-else", claimedAt, expiresAt } })}\n`);
		harness = await startHost({ dataDir: harness.dataDir });
		const refused = await harness.call("POST", `/sessions/${sessionId}/claim`, { requestId: "c-t", takeover: true }, SECOND);
		assert.equal(refused.status, 409);
		assert.equal(refused.body.code, "lease_held");
		assert.equal(refused.body.details.canTakeOver, false);
		assert.equal(refused.body.details.holder.clientId, "their-tab");
	});

	it("takes over mid-run: the run goes on, and the new holder can stop it", async () => {
		const hold = gate();
		harness.faux.setResponses([
			async (_context, options) => {
				await held(hold, options);
				return fauxAssistantMessage("never finished");
			},
		]);
		const sessionId = await createSession(harness);
		await harness.call("POST", `/sessions/${sessionId}/commands`, { requestId: "p-1", op: "prompt", text: "A long job" });
		await harness.waitFor(sessionId, (event) => event.type === "run.started");
		const taken = await harness.call("POST", `/sessions/${sessionId}/claim`, { requestId: "c-1", takeover: true }, SECOND);
		assert.equal(taken.status, 200);
		const snapshot = await harness.call("GET", `/sessions/${sessionId}`, undefined, SECOND);
		assert.equal(snapshot.body.value.session.status, "running", "the run was not touched");
		const abort = await harness.call("POST", `/sessions/${sessionId}/commands`, { requestId: "a-1", op: "abort" }, SECOND);
		assert.equal(abort.status, 200);
		assert.equal(abort.body.value.command.result.abortedRun, true);
		hold.open();
		const settled = await harness.waitFor(sessionId, (event) => event.type === "run.settled");
		assert.equal(settled.payload.aborted, true);
	});

	it("keeps the new holder across a host restart", async () => {
		const sessionId = await createSession(harness);
		await harness.call("POST", `/sessions/${sessionId}/claim`, { requestId: "c-1", takeover: true }, SECOND);
		await harness.stop();
		harness = await startHost({ dataDir: harness.dataDir });
		const snapshot = await harness.call("GET", `/sessions/${sessionId}`);
		assert.equal(snapshot.body.value.session.lease.clientId, SECOND.clientId);
	});
});

describe("the transcript's times", () => {
	it("carries pi's own entry timestamps: each user turn when it was taken, each step of a reply when it ended, after a restart too", async () => {
		const harness = await startHost();
		try {
			harness.faux.setResponses([
				fauxAssistantMessage(fauxToolCall("echo_time", { at: "now" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("first answer"),
				fauxAssistantMessage("second answer"),
			]);
			const sessionId = await createSession(harness);
			const before = Date.now();
			await harness.call("POST", `/sessions/${sessionId}/commands`, { requestId: "p-1", op: "prompt", text: "First question" });
			await harness.waitFor(sessionId, (event) => event.type === "run.settled");
			await new Promise((resolve) => setTimeout(resolve, 1100));
			const between = await cursorOf(harness, sessionId);
			await harness.call("POST", `/sessions/${sessionId}/commands`, { requestId: "p-2", op: "prompt", text: "Second question" });
			await harness.waitFor(sessionId, (event) => event.type === "run.settled" && event.seq > between);
			const after = Date.now();

			const live = (await harness.call("GET", `/sessions/${sessionId}`)).body.value.transcript as { entryId: string; role: string; timestamp?: string; text: string }[];

			// pi's own file is the authority (read once the host stopped: pi writes it a moment after the run).
			await harness.stop();
			const recorded = readFileSync(harness.host.piFileOf(sessionId) as string, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { type: string; id: string; timestamp: string })
				.filter((entry) => entry.type === "message");
			const byId = new Map(recorded.map((entry) => [entry.id, entry.timestamp]));

			const check = (transcript: { entryId: string; role: string; timestamp?: string; text: string }[]) => {
				assert.ok(transcript.length >= 4, JSON.stringify(transcript));
				assert.ok(transcript.some((item) => item.role === "toolResult"), "every kind of entry is covered");
				let previous = before - 1;
				for (const item of transcript) {
					assert.equal(typeof item.timestamp, "string", `${item.role} ${item.entryId} has a timestamp`);
					assert.equal(item.timestamp, byId.get(item.entryId), "the timestamp is pi's, as recorded");
					const at = Date.parse(item.timestamp as string);
					assert.ok(at >= previous && at <= after, "in order, within the test");
					previous = at;
				}
				const users = transcript.filter((item) => item.role === "user");
				assert.deepEqual(users.map((item) => item.text), ["First question", "Second question"]);
				assert.ok(Date.parse(users[1]?.timestamp as string) - Date.parse(users[0]?.timestamp as string) >= 1000, "not all one time");
			};
			// The live body's view, and the file's after a restart (no body): the same times.
			check(live);
			const revived = await startHost({ dataDir: harness.dataDir });
			try {
				const fromFile = (await revived.call("GET", `/sessions/${sessionId}`)).body.value.transcript;
				check(fromFile);
				assert.deepEqual(fromFile.map((item: { timestamp: string }) => item.timestamp), live.map((item) => item.timestamp));
			} finally {
				await revived.cleanup();
			}
		} finally {
			await harness.cleanup();
		}
	});
});
